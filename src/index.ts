import {API, BulkTransactions, SaveTransaction} from "ynab";
import yahooFinance from 'yahoo-finance2';
import ClearedEnum = SaveTransaction.ClearedEnum;
import FlagColorEnum = SaveTransaction.FlagColorEnum;
import {QuoteResponseMap} from "yahoo-finance2/dist/esm/src/modules/quote";

const run = async () => {
    if (!process.env?.YNAB_API_TOKEN || !process.env?.YNAB_BUDGET_ID) {
        throw "Missing environment variables";
    }
    const ynabAPI = new API(process.env.YNAB_API_TOKEN);

    console.log(`[INFO] Fetching budget...`)
    const {data: {budget}} = await ynabAPI.budgets.getBudgetById(process.env.YNAB_BUDGET_ID);
    console.log(`[INFO] Fetched.`)

    console.log(`[INFO] Fetching accounts...`)
    const {data: {accounts}} = await ynabAPI.accounts.getAccounts(budget.id);
    console.log(`[INFO] Fetched ${accounts.length} accounts.`)

    const investmentAccounts = accounts.filter((account) => account?.note?.includes("INVESTMENT_TO_TRACK"));
    console.log(`[INFO] ${investmentAccounts} investment accounts found.`)

    for (const account of investmentAccounts) {
        console.log(`[INFO] Processing account ${account.name}...`)

        const accountHoldings: Map<string, { count: number, value: number }> = new Map();

        console.log(`[INFO] Fetching transactions...`);
        const {data} = await ynabAPI.transactions.getTransactionsByAccount(process.env.YNAB_BUDGET_ID, account.id);
        console.log(`[INFO] Fetched ${data.transactions.length} transactions.`)

        const transactions = data.transactions.map(t => {
            return {...t, date: Date.parse(t.date)};
        })

        console.log(`[INFO] Processing transactions...`);
        transactions.forEach(t => {
            if (t?.payee_name?.startsWith("$")) {
                const ticker = t.payee_name.replace("$","").trim();
                const holding = accountHoldings.get(ticker) || {count: 0, value: 0};
                holding.value = holding.value + t.amount;
                if (t?.memo?.startsWith("BUY")) {
                    holding.count = holding.count + +t.memo.split(" ")[1]
                }
                if (t?.memo?.startsWith("SELL")) {
                    holding.count = holding.count - +t.memo.split(" ")[1]
                }
                accountHoldings.set(ticker, holding)
            }
        });
        console.log(`[INFO] Transactions processed.`)

        console.log(`[INFO] Current holdings:`)
        accountHoldings.forEach(({count, value}, ticker) => {
            console.log(`       [${ticker}] Shares: ${count} Value: $${value}`)
        });


        console.log(`[INFO] Fetching quotes...`);
        const quotes: QuoteResponseMap = await yahooFinance.quote([...accountHoldings.keys()], { fields: ["regularMarketPrice"], return: "map" });
        console.log(`[INFO] Fetched quotes.`);

        const bulkTransactions: BulkTransactions = {transactions: []}
        const currentDate = new Date();
        const offset = currentDate.getTimezoneOffset();

        accountHoldings.forEach(({count, value}, ticker) => {
            const quote = quotes.get(ticker);
            if (!quote?.regularMarketPrice) {
                console.log(`[WARNING] Failed to get quote for: ${ticker}`)
            } else {
                const difference = (quote.regularMarketPrice * count) - value;

                if (difference !== 0) {
                    console.log(`[INFO] Creating update transaction for ${ticker} of $${difference} in ${account.name}`)

                    bulkTransactions.transactions.push({
                        "account_id": account.id,
                        "date": new Date(currentDate.getTime() - (offset*60*1000)).toISOString().split('T')[0],
                        "amount": difference,
                        "payee_name": `$${ticker}`,
                        "memo": "PRICE CHANGE",
                        "cleared": ClearedEnum.Cleared,
                        "approved": true,
                        "flag_color": FlagColorEnum.Blue
                    },)
                }
            }
        });

        if (bulkTransactions.transactions.length ===0) {
            console.log(`[INFO] No updates needed.`);
        } else {
            console.log(`[INFO] Updates:`)
            bulkTransactions.transactions.forEach((tx) => {
                console.log(`       [${tx.payee_name}] $${tx.amount}`)
            });

            console.log(`[INFO] Posting transactions to YNAB...`)
            await ynabAPI.transactions.bulkCreateTransactions(process.env.YNAB_BUDGET_ID, bulkTransactions);
            console.log(`[INFO] Posted transactions.`)
        }
    }
}

module.exports.run