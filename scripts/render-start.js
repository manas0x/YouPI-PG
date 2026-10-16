/**
 * Render single-service launcher.
 *
 * Render exposes one public HTTP port per web service. The gateway itself is
 * split into native services, so this launcher keeps the services on loopback
 * ports and puts a small path router on Render's public PORT.
 */
import http from 'node:http';

const publicPort = Number(process.env.PORT || 10000);
const paymentApiPort = Number(process.env.PAYMENT_API_PORT || 6100);
const checkoutPort = Number(process.env.CHECKOUT_PORTAL_PORT || 7000);
const adminPort = Number(process.env.MERCHANT_ADMIN_PORT || 6001);
const storePort = Number(process.env.COIN_STORE_PORT || 5000);
const gmailPort = Number(process.env.GMAIL_OBSERVER_PORT || 6003);
const smsPort = Number(process.env.SMS_OBSERVER_PORT || 6002);

const publicBaseUrl = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${publicPort}`).replace(/\/$/, '');
process.env.BASE_CHECKOUT_URL = process.env.BASE_CHECKOUT_URL || publicBaseUrl;
process.env.BASE_PAYMENT_API_URL = process.env.BASE_PAYMENT_API_URL || publicBaseUrl;
process.env.COIN_STORE_WEBHOOK_URL = process.env.COIN_STORE_WEBHOOK_URL || `http://127.0.0.1:${storePort}/api/webhook`;
process.env.PAYMENT_API_INTERNAL_URL = process.env.PAYMENT_API_INTERNAL_URL || `http://127.0.0.1:${paymentApiPort}`;

const services = [];

function proxyRequest(req, res, targetPort, targetPath = req.url) {
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${targetPort}`,
      'x-forwarded-host': req.headers.host || publicBaseUrl,
      'x-forwarded-proto': 'https'
    }
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxy.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal gateway service unavailable', details: err.message }));
    }
  });

  req.pipe(proxy);
}

function routeRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'UP', service: 'youpi-render-gateway', publicBaseUrl }));
    return;
  }

  if (
    pathname.startsWith('/checkout') ||
    pathname.startsWith('/icons/') ||
    pathname === '/youpi.js' ||
    pathname === '/sdk/youpi.js' ||
    pathname === '/sdk/youpi-checkout.js'
  ) {
    proxyRequest(req, res, checkoutPort);
    return;
  }

  if (pathname === '/admin' || pathname === '/youpi-sms-gateway.apk') {
    proxyRequest(req, res, adminPort);
    return;
  }

  if (
    pathname.startsWith('/api/admin/') ||
    pathname.startsWith('/api/services') ||
    pathname === '/api/logs/stream'
  ) {
    proxyRequest(req, res, adminPort);
    return;
  }

  // Store-owned routes must win over the gateway API's generic /api/* space.
  if (
    pathname === '/api/checkout' ||
    pathname === '/api/order-status' ||
    pathname === '/api/wallet-balance' ||
    pathname === '/api/webhook' ||
    pathname === '/webhook' ||
    pathname === '/api/verify-payment' ||
    pathname === '/openapi.yaml' ||
    pathname.startsWith('/assets/') ||
    pathname === '/' ||
    pathname === '/store' ||
    pathname === '/wallet' ||
    pathname.startsWith('/order-') ||
    pathname === '/success' ||
    pathname === '/failed' ||
    pathname === '/suspicious' ||
    pathname === '/expired' ||
    pathname === '/cancelled'
  ) {
    proxyRequest(req, res, storePort);
    return;
  }

  if (pathname.startsWith('/api/v1/')) {
    proxyRequest(req, res, paymentApiPort);
    return;
  }

  proxyRequest(req, res, storePort);
}

async function start() {
  // Start the database-owning API first so migrations finish before the other
  // services open the same SQLite file.
  const { startServer } = await import('../apps/payment-api/src/index.js');
  const paymentApi = await startServer(paymentApiPort);

  const { startCheckoutServer } = await import('../apps/checkout-portal/src/index.js');
  const checkout = await startCheckoutServer(checkoutPort, {
    apiBaseUrl: `http://127.0.0.1:${paymentApiPort}`
  });

  const { startCoinWalletStore } = await import('../apps/coin-wallet-store/src/index.js');
  const store = await startCoinWalletStore(storePort, {
    gatewayApiUrl: `http://127.0.0.1:${paymentApiPort}`
  });

  const { startAdminServer } = await import('../apps/merchant-admin/src/index.js');
  const admin = await startAdminServer(adminPort, {
    apiBaseUrl: `http://127.0.0.1:${paymentApiPort}`
  });

  services.push(paymentApi, checkout, store, admin);

  if (process.env.RENDER_ENABLE_OBSERVERS === 'true') {
    const [{ startGmailObserver }, { startSmsObserver }] = await Promise.all([
      import('../apps/gmail-observer/src/index.js'),
      import('../apps/sms-observer/src/index.js')
    ]);
    services.push(
      await startGmailObserver(gmailPort, { apiBaseUrl: `http://127.0.0.1:${paymentApiPort}` }),
      await startSmsObserver(smsPort, { apiBaseUrl: `http://127.0.0.1:${paymentApiPort}` })
    );
  }

  const publicServer = http.createServer(routeRequest);
  services.push({ close: () => new Promise(resolve => publicServer.close(resolve)) });
  publicServer.listen(publicPort, '0.0.0.0', () => {
    console.log(`[Render] YOUPI gateway public router listening on ${publicPort}`);
    console.log(`[Render] Public base URL: ${publicBaseUrl}`);
  });
}

async function shutdown(signal) {
  console.log(`[Render] Received ${signal}; shutting down gateway services.`);
  await Promise.allSettled(services.reverse().map(service => service.close?.()));
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(error => {
  console.error('[Render] Gateway startup failed:', error);
  process.exit(1);
});
