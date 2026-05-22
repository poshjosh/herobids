// spike-kraken-futures.ts — validate ccxt + Kraken Futures derivatives
import ccxt from 'ccxt';

const exchange = new ccxt.krakenfutures({
  apiKey: process.env.KRAKEN_FUTURES_KEY!,
  secret: process.env.KRAKEN_FUTURES_SECRET!,
  sandbox: true, // demo environment
});

async function main() {
  // 1. Confirm connectivity — fetch perpetual markets
  const markets = await exchange.loadMarkets();
  const perps = Object.values(markets).filter(m => m.type === 'swap');
  console.log(`Found ${perps.length} perpetuals`);
  console.log('BTC perp:', perps.find(m => m.base === 'BTC')?.symbol);

  // 2. Check balance / margin
  const balance = await exchange.fetchBalance();
  console.log('Free USD:', balance.USD?.free);

  // 3. Set leverage on BTC/USD:USD perpetual
  const symbol = 'BTC/USD:USD';
  await exchange.setLeverage(5, symbol);
  console.log('Leverage set to 5x on', symbol);

  // 4. Open a short position — limit order below market
  const ticker = await exchange.fetchTicker(symbol);
  const price = ticker.bid! * 0.999; // slightly below bid to fill on demo
  const amount = 0.001; // min contract size

  console.log(`Placing short limit @ ${price.toFixed(1)}, size ${amount} BTC`);
  const order = await exchange.createOrder(symbol, 'limit', 'sell', amount, price);
  console.log('Order ID:', order.id, '| Status:', order.status);

  // 5. Fetch open orders
  const openOrders = await exchange.fetchOpenOrders(symbol);
  console.log('Open orders:', openOrders.length);

  // 6. Fetch positions
  const positions = await exchange.fetchPositions([symbol]);
  for (const pos of positions) {
    if (pos.contracts && pos.contracts > 0) {
      console.log(`Position: ${pos.side} ${pos.contracts} @ ${pos.entryPrice}`);
    }
  }

  // 7. Cancel the order (cleanup)
  if (order.status === 'open') {
    await exchange.cancelOrder(order.id, symbol);
    console.log('Order cancelled');
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
