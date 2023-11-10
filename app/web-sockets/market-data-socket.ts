import WebSocket from "ws";
import { db } from "../db";
import EmaCalculator from "../trading/ema-calculator";
import { Trader } from "../trading/trader";

const apiKey: string = process.env.GEMINI_API_KEY!;
const apiSecret: string = process.env.GEMINI_API_SECRET!;

class MarketDataWebSocket {
  private ws: WebSocket;
  private emaCalculator: EmaCalculator;
  private trader: Trader;

  constructor(private url: string) {
    this.ws = new WebSocket(this.url);
    this.emaCalculator = new EmaCalculator(30, 60);
    this.trader = new Trader(apiKey, apiSecret);
    this.ws.on("open", this.onOpen.bind(this));
    this.ws.on("message", this.onMessage.bind(this));
    this.ws.on("close", this.onClose.bind(this));
    this.ws.on("error", this.onError.bind(this));
  }

  private onOpen() {
    console.log("Connected to the MarketData WebSocket server!");
    const subscribeMessage = {
      type: "subscribe",
      subscriptions: [{ name: "candles_1m", symbols: ["BTCUSD"] }],
    };
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  private async onMessage(data: WebSocket.Data) {
    const message = JSON.parse(data.toString());
    if (message.type === "candles_1m_updates") {
      const candle = message.changes[0];
      const [, , , , close] = candle;

      console.log("ok got a new message, here is close", close);
      this.emaCalculator.updatePrice(close);

      const shortTermEma = this.emaCalculator.getShortTermEma();
      const longTermEma = this.emaCalculator.getLongTermEma();

      if (shortTermEma && longTermEma && shortTermEma > longTermEma) {
        console.log("OK BUY SIGNAL");

        const openOrderCount = await db.trade.count({
          where: { status: "open" },
        });

        console.log("CURRENT OPEN ORDERS: ", openOrderCount);

        if (openOrderCount > 0) return;

        console.log("WE BUYING! 🚀");

        async function calculateTotalForNewTrade(
          defaultValue: number
        ): Promise<number> {
          // Fetch all winning trades
          const winningTrades = await db.trade.findMany({
            where: { win: true },
          });

          // Calculate total profit from winning trades
          const totalProfit = winningTrades.reduce(
            (acc, trade) => acc + (trade.profit || 0),
            0
          );

          // If there's no profit, use the default value
          if (totalProfit === 0) {
            return defaultValue;
          }

          // Otherwise, add the total profit to the default value
          return defaultValue + totalProfit;
        }

        const amountToBuy = await calculateTotalForNewTrade(5);

        // basically a market order
        const order = await this.trader.buy({
          amountUSD: amountToBuy,
          options: ["immediate-or-cancel"],
          executionPriceMultiplier: 1.001,
          symbol: "btcusd",

          type: "exchange limit",
        });

        if (order && order.executed_amount) {
          // OK - buy worked, lets add that to my open buys and set the limit sell
          const {
            client_order_id,
            symbol,
            avg_execution_price,
            executed_amount,
          } = order;

          console.log(`ORDER PLACED, BOUGHT: ${amountToBuy} of ${symbol}`);

          let amountSpent =
            parseFloat(avg_execution_price) * parseFloat(executed_amount);

          await db.trade.create({
            data: {
              id: client_order_id,
              money_spent: parseFloat(amountSpent.toFixed(2)),
              buy_price: parseFloat(avg_execution_price),
              buy_coin_amount: parseFloat(executed_amount),
              symbol,
            },
          });

          const sellAtLimit = parseFloat(avg_execution_price) * 1.02;

          const sellOrder = await this.trader.sell({
            symbol,
            sellAmount: executed_amount,
            sellAtPrice: sellAtLimit.toString(),
          });

          console.log("SELL ORDER PLACED", sellOrder);
        }
      }

      console.log("short term ema", shortTermEma);
      console.log("long term ema", longTermEma);
    }
  }

  private onClose() {
    console.log("Disconnected from the MarketData WebSocket server!");
    // Handle reconnection logic here
  }

  private onError(error: Error) {
    console.error("WebSocket error:", error);
    // Handle error and possible reconnection logic here
  }
}

export default MarketDataWebSocket;
