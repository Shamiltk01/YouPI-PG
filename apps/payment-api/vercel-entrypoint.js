export function createVercelHandler(createApp = async () => {
  const { createPaymentApp } = await import('./src/index.js');
  return createPaymentApp();
}) {
  let appPromise = null;

  return async function handler(req, res) {
    if (!appPromise) appPromise = Promise.resolve().then(createApp);
    const pending = appPromise;
    let app;
    try {
      app = await pending;
    } catch (error) {
      if (appPromise === pending) appPromise = null;
      console.error('[Payment API] Vercel startup failed:', error);
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(JSON.stringify({
        error: 'Payment API could not start. Check the deployment environment and Vercel runtime logs.',
        code: 'PAYMENT_API_STARTUP_FAILED'
      }));
      return;
    }
    return app.rawServer.emit('request', req, res);
  };
}

export default createVercelHandler();
