import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { YoupiPaymentClient } from '@youpi/merchant-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

export class CoinWalletStoreServer {
  /**
   * @param {{
   *   gatewayApiUrl?: string,
   *   merchantId?: string,
   *   webhookSecret?: string
   * }} [options={}]
   */
  constructor(options = {}) {
    const internalPort = process.env.PAYMENT_API_PORT || 6100;
    this.gatewayApiUrl = options.gatewayApiUrl || process.env.PAYMENT_API_INTERNAL_URL || `http://127.0.0.1:${internalPort}`;
    this.merchantId = options.merchantId || '00000000-0000-0000-0000-000000000001';
    this.webhookSecret = options.webhookSecret || process.env.COIN_STORE_WEBHOOK_SECRET || 'merchant_webhook_secret_for_wallet_store';

    this.paymentClient = new YoupiPaymentClient({
      apiUrl: this.gatewayApiUrl,
      merchantId: this.merchantId,
      webhookSecret: this.webhookSecret
    });

    // In-memory persistent wallet balance & ledger for demo store
    this.walletCoins = 50; // default starting balance
    this.transactionHistory = [];
    this.pendingOrders = new Map();
    this.processedDeliveryIds = new Set();

    this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8');
    this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8');
    this.orderSuccessHtml = fs.readFileSync(path.join(__dirname, 'order-success.html'), 'utf8');
    this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8');
    this.orderSuspiciousHtml = fs.readFileSync(path.join(__dirname, 'order-suspicious.html'), 'utf8');
    this.orderExpiredHtml = fs.readFileSync(path.join(__dirname, 'order-expired.html'), 'utf8');
    this.orderCancelledHtml = fs.readFileSync(path.join(__dirname, 'order-cancelled.html'), 'utf8');
  }

  creditCoins(orderId, coins, packName) {
    this.walletCoins += Number(coins);
    this.transactionHistory.unshift({
      orderId,
      packName: packName || 'Coin Pack',
      coins: Number(coins),
      status: 'CREDITED',
      timestamp: new Date().toISOString()
    });
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;
      const method = req.method.toUpperCase();

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Gateway-Signature, X-Gateway-Event'
        });
        res.end();
        return;
      }

      // GET /assets/* (serve product screenshots and icons)
      if (pathname.startsWith('/assets/') && (method === 'GET' || method === 'HEAD')) {
        const assetName = path.basename(pathname);
        const assetPath = path.join(__dirname, '../public/assets', assetName);
        if (fs.existsSync(assetPath)) {
          const ext = path.extname(assetName).toLowerCase();
          const contentType = ext === '.png' ? 'image/png' : ext === '.svg' ? 'image/svg+xml' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400'
          });
          if (method === 'HEAD') { res.end(); return; }
          const stream = fs.createReadStream(assetPath);
          stream.pipe(res);
          return;
        }
      }

      // GET /health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'coin-wallet-store', coins: this.walletCoins }));
        return;
      }

      // GET /youpi.js or /sdk/youpi-checkout.js (Universal Frontend Integration Script)
      if (pathname === '/youpi.js' || pathname === '/sdk/youpi-checkout.js' || pathname === '/sdk/youpi.js') {
        const sdkPath = path.resolve(__dirname, '../../checkout-portal/src/sdk/youpi.js');
        if (fs.existsSync(sdkPath)) {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(sdkPath, 'utf8'));
          return;
        }
      }

      // GET /openapi.yaml (Public Developer Integration Specification)
      if (pathname === '/openapi.yaml') {
        const openApiPath = path.resolve(__dirname, '../../../openapi.yaml');
        if (fs.existsSync(openApiPath)) {
          res.writeHead(200, {
            'Content-Type': 'text/yaml; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(fs.readFileSync(openApiPath, 'utf8'));
          return;
        }
      }

      // REVERSE PROXY: /checkout/* and /icons/* -> Checkout Portal (Port 7000)
      if (pathname.startsWith('/checkout') || pathname.startsWith('/icons/')) {
        const portalPort = Number(process.env.CHECKOUT_PORT || 7000);
        const proxyReq = http.request({
          hostname: '127.0.0.1',
          port: portalPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${portalPort}`,
            'x-forwarded-host': req.headers.host || '',
            'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
          }
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Checkout Portal unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // REVERSE PROXY: /api/v1/* -> Payment API (Port 6100 / gatewayApiUrl)
      if (pathname.startsWith('/api/v1/')) {
        try {
          const parsedGateway = new URL(this.gatewayApiUrl);
          const proxyReq = http.request({
            hostname: parsedGateway.hostname || '127.0.0.1',
            port: Number(parsedGateway.port || process.env.PAYMENT_API_PORT || 6100),
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: `${parsedGateway.hostname}:${parsedGateway.port}`,
              'x-forwarded-host': req.headers.host || '',
              'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http'
            }
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Payment Gateway API unavailable', details: err.message }));
            }
          });

          req.pipe(proxyReq);
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to proxy payment API', details: err.message }));
          return;
        }
      }

      // GET / or /store
      if ((pathname === '/' || pathname === '/store') && (method === 'GET' || method === 'HEAD')) {
        try { this.storeHtml = fs.readFileSync(path.join(__dirname, 'store.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.storeHtml);
        return;
      }

      // GET /wallet
      if (pathname === '/wallet' && (method === 'GET' || method === 'HEAD')) {
        try { this.walletHtml = fs.readFileSync(path.join(__dirname, 'wallet.html'), 'utf8'); } catch {}
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(this.walletHtml);
        return;
      }

      // GET /order-success or /success
      if ((pathname === '/order-success' || pathname === '/success') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderSuccessHtml = fs.readFileSync(path.join(__dirname, 'order-success.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        const amount = url.searchParams.get('amount') || '499.00';
        const utr = url.searchParams.get('utr') || url.searchParams.get('bankRef') || '123456789012';
        const mode = url.searchParams.get('mode') || url.searchParams.get('payment_mode') || 'UPI';
        const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        let rendered = this.orderSuccessHtml
          .replaceAll('{{ORDER_ID}}', orderId)
          .replaceAll('{{AMOUNT}}', amount)
          .replaceAll('{{UTR}}', utr)
          .replaceAll('{{MODE}}', mode)
          .replaceAll('{{TIMESTAMP}}', timestamp);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-failed or /failed
      if ((pathname === '/order-failed' || pathname === '/failed') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderFailedHtml = fs.readFileSync(path.join(__dirname, 'order-failed.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        const reason = url.searchParams.get('reason') || 'Transaction verification timed out or declined.';
        let rendered = this.orderFailedHtml
          .replaceAll('{{ORDER_ID}}', orderId)
          .replaceAll('ORDER-#', orderId)
          .replaceAll('{{REASON}}', reason);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-suspicious or /suspicious
      if ((pathname === '/order-suspicious' || pathname === '/suspicious') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderSuspiciousHtml = fs.readFileSync(path.join(__dirname, 'order-suspicious.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderSuspiciousHtml.replaceAll('{{ORDER_ID}}', orderId);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-expired or /expired
      if ((pathname === '/order-expired' || pathname === '/expired') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderExpiredHtml = fs.readFileSync(path.join(__dirname, 'order-expired.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderExpiredHtml.replaceAll('{{ORDER_ID}}', orderId);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /order-cancelled or /cancelled
      if ((pathname === '/order-cancelled' || pathname === '/cancelled') && (method === 'GET' || method === 'HEAD')) {
        try { this.orderCancelledHtml = fs.readFileSync(path.join(__dirname, 'order-cancelled.html'), 'utf8'); } catch {}
        const orderId = url.searchParams.get('order_id') || url.searchParams.get('orderId') || 'ORDER-DEMO';
        let rendered = this.orderCancelledHtml.replaceAll('{{ORDER_ID}}', orderId);

        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
        });
        if (method === 'HEAD') { res.end(); return; }
        res.end(rendered);
        return;
      }

      // GET /api/wallet-balance
      if (pathname === '/api/wallet-balance' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          coins: this.walletCoins,
          history: this.transactionHistory
        }));
        return;
      }

      // POST /api/checkout (Customer clicks purchase pack)
      if (pathname === '/api/checkout' && method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}');
            const rawVal = data.price !== undefined ? data.price : (data.amount !== undefined ? data.amount : 1.00);
            const price = Number(rawVal);
            if (isNaN(price) || price < 1) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Minimum top-up amount is ₹1.00' }));
              return;
            }
            const orderId = `COIN-ORD-${Date.now()}`;
            const amountStr = price.toFixed(2);
            const proto = req.headers['x-forwarded-proto'] || (req.headers.host?.includes('example.com') ? 'https' : 'http');
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5000';
            const returnUrl = `${proto}://${host}/wallet?orderId=${orderId}`;

            // Call YOUPI Payment Gateway via SDK
            const payment = await this.paymentClient.createPayment({
              orderId,
              amount: amountStr,
              currency: 'INR',
              returnUrl,
              customer: {
                fullName: data.customerName || data.gamerTag || 'Demo Customer',
                phoneNumber: data.phoneNumber || ''
              },
              metadata: {
                coins: data.coins || Math.round(price),
                packName: data.packName || data.productName || 'Gamer Pack'
              }
            });

            this.pendingOrders.set(orderId, {
              orderId,
              paymentId: payment.paymentId,
              amount: amountStr,
              amountPaise: Math.round(price * 100),
              coins: Number(data.coins || Math.round(price)),
              packName: data.packName || data.productName || 'Gamer Pack',
              status: 'PENDING',
              createdAt: new Date().toISOString()
            });

            // Normalize checkoutUrl for localhost development / testing to prevent tunnel offline issues
            let resolvedCheckoutUrl = payment.checkoutUrl;
            if (host.includes('localhost') || host.includes('127.0.0.1')) {
              resolvedCheckoutUrl = `${proto}://${host}/checkout/${payment.paymentId}`;
            }

            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({
              orderId,
              paymentId: payment.paymentId,
              checkoutUrl: resolvedCheckoutUrl
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // GET /api/order-status (read-only status for the demo UI)
      if (pathname === '/api/order-status' && method === 'GET') {
        const orderId = url.searchParams.get('orderId') || url.searchParams.get('order_id');
        const order = orderId ? this.pendingOrders.get(orderId) : null;
        if (!order) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Order not found' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          orderId: order.orderId,
          paymentId: order.paymentId,
          amount: order.amount,
          coins: order.coins,
          packName: order.packName,
          status: order.status,
          credited: this.transactionHistory.some(item => item.orderId === order.orderId),
          walletCoins: this.walletCoins
        }));
        return;
      }

      // POST /api/verify-payment is intentionally not a fulfillment endpoint.
      // Browser callbacks are untrusted; only the signed webhook below credits coins.
      if (pathname === '/api/verify-payment' && method === 'POST') {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          error: 'Browser payment callbacks cannot fulfill orders. Await the signed gateway webhook.'
        }));
        return;
      }

      // POST /api/webhook or /webhook (Signed webhook listener from YOUPI PG)
      if ((pathname === '/api/webhook' || pathname === '/webhook') && method === 'POST') {
        const chunks = [];
        req.on('data', chunk => { chunks.push(chunk); });
        req.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const signature = req.headers['x-gateway-signature'];
          const deliveryId = req.headers['x-gateway-delivery-id'];

          try {
            if (deliveryId && this.processedDeliveryIds.has(deliveryId)) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ received: true, duplicate: true }));
              return;
            }

            // Verify HMAC-SHA256 signature using merchant SDK
            const event = this.paymentClient.verifyWebhook(rawBody.toString('utf8'), signature);

            if (event.event === 'SUCCESS' || event.status === 'SUCCESS') {
              const orderId = event.orderId || event.data?.orderId;
              const pendingOrder = this.pendingOrders.get(orderId);
              const paymentId = event.paymentId || event.data?.paymentId;
              const amountPaise = Number(event.amountPaise || event.data?.amountPaise);

              if (!pendingOrder) {
                throw new Error('Unknown orderId in webhook. Order was not created by this store.');
              }
              if (paymentId && paymentId !== pendingOrder.paymentId) {
                throw new Error('Webhook paymentId does not match the pending store order.');
              }
              if (Number.isFinite(amountPaise) && amountPaise !== pendingOrder.amountPaise) {
                throw new Error('Webhook amount does not match the pending store order.');
              }

              const alreadyCredited = this.transactionHistory.some(t => t.orderId === orderId);
              if (!alreadyCredited) {
                this.creditCoins(orderId, pendingOrder.coins, pendingOrder.packName);
                pendingOrder.status = 'PAID';
                pendingOrder.paidAt = new Date().toISOString();
                console.log(`[Coin Wallet Store] Signed webhook received. Credited ${pendingOrder.coins} coins for Order ${orderId}. New balance: ${this.walletCoins}`);
              }
            }

            if (deliveryId) this.processedDeliveryIds.add(deliveryId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: true, credited: true }));
          } catch (err) {
            console.error('[Coin Wallet Store] Webhook verification failed:', err.message);
            res.writeHead(err.message.includes('signature') ? 401 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Route Not Found');
    });
  }
}
