import {Account, API, BulkTransactions, SaveTransaction, TransactionsResponseData} from "ynab";
import yahooFinance from 'yahoo-finance2';
import ClearedEnum = SaveTransaction.ClearedEnum;
import FlagColorEnum = SaveTransaction.FlagColorEnum;
import { QuoteResponseMap} from "yahoo-finance2/dist/esm/src/modules/quote";

type THoldings = Map<string, { count: number, value: number }>;

export const run = async () => {
    if (!process.env?.YNAB_API_TOKEN || !process.env?.YNAB_BUDGET_ID) {
        throw "Missing environment variables";
    } else {
        const budgetID = process.env.YNAB_BUDGET_ID;
        const ynabAPI = new API(process.env.YNAB_API_TOKEN);

        console.log(`[YNIT] Fetching budget...`);
        const {data: {budget}} = await ynabAPI.budgets.getBudgetById(budgetID);
        console.log(`[YNIT] Fetched.`);

        console.log(`[YNIT] Fetching accounts...`);
        const {data: {accounts}} = await ynabAPI.accounts.getAccounts(budget.id);
        console.log(`[YNIT] Fetched ${accounts.length} accounts.`);

        const investmentAccounts = accounts.filter((account) => account?.note?.includes("INVESTMENT_ACCOUNT"));
        console.log(`[YNIT] Found ${investmentAccounts.length} investment accounts.`);

        await Promise.all(investmentAccounts.map(account => processAccount(ynabAPI, budgetID, account)));
    }
}

const processAccount = async (ynabAPI: API, budgetID: string, account: Account) => {
    console.log(`[YNIT] Processing account ${account.name}...`);

    console.log(`[YNIT] Fetching transactions...`);
    const {data} = await ynabAPI.transactions.getTransactionsByAccount(budgetID, account.id);
    console.log(`[YNIT] Fetched ${data.transactions.length} transactions.`);

    const accountHoldings = buildAccountHoldingsFromTransactions(data)

    console.log(`[YNIT] Current holdings:`);
    accountHoldings.forEach(({count, value}, ticker) => {
        console.log(`       [${ticker}] Shares: ${count} Value: $${value}`);
    });


    console.log(`[YNIT] Fetching quotes...`);
    const quotes: QuoteResponseMap = await yahooFinance.quote(Array.from(accountHoldings.keys()), { fields: ["regularMarketPrice"], return: "map" });
    console.log(`[YNIT] Fetched quotes.`);

    const bulkTransactions = buildUpdateTransactionsFromQuotesAndHoldings(account, quotes, accountHoldings)

    if (bulkTransactions.transactions.length ===0) {
        console.log(`[YNIT] No updates needed.`);
    } else {
        console.log(`[YNIT] Updates:`);
        bulkTransactions.transactions.forEach((tx) => {
            console.log(`       [${tx.memo}] $${tx.amount/1000}`);
        });

        console.log(`[YNIT] Posting transactions to YNAB...`);
        await ynabAPI.transactions.bulkCreateTransactions(budgetID, bulkTransactions);
        console.log(`[YNIT] Posted transactions.`);
    }
}

const buildAccountHoldingsFromTransactions = ( data: TransactionsResponseData): THoldings => {
    const accountHoldings: THoldings  = new Map();

    const transactions = data.transactions.map(t => {
        return {...t, date: Date.parse(t.date)};
    });

    console.log(`[YNIT] Processing transactions...`);

    transactions.forEach(t => {
        if (t?.memo && t?.memo?.startsWith("$")) {
            const [ticker, action] = t.memo.replace("$","").split("|")
            const holding = accountHoldings.get(ticker) || {count: 0, value: 0};
            holding.value = holding.value + (t.amount/1000);
            if (action.startsWith("BUY")) {
                holding.count = holding.count + +action.split(" ")[1];
            }
            if (t?.memo && t?.memo?.startsWith("SELL")) {
                holding.count = holding.count - +action.split(" ")[1];
            }
            accountHoldings.set(ticker, holding);
        }
    });

    console.log(`[YNIT] Transactions processed.`);
    return accountHoldings;
}

const buildUpdateTransactionsFromQuotesAndHoldings = (account: Account, quotes: QuoteResponseMap, holdings: THoldings): BulkTransactions => {
    const bulkTransactions: BulkTransactions = {transactions: []};
    const currentDate = new Date();
    const offset = currentDate.getTimezoneOffset();

    holdings.forEach(({count, value}, ticker) => {
        const quote = quotes.get(ticker);
        if (!quote?.regularMarketPrice) {
            console.log(`[WARNING] Failed to get quote for: ${ticker}`);
        } else {
            const difference = (quote.regularMarketPrice * count) - value;

            if (Math.round(difference*1000) !== 0) {

                bulkTransactions.transactions.push({
                    "account_id": account.id,
                    "date": new Date(currentDate.getTime() - (offset*60*1000)).toISOString().split('T')[0],
                    "amount": Math.round(difference*1000),
                    "payee_name": `Investment Value Update`,
                    "memo": `$${ticker}|VALUE_UPDATE`,
                    "cleared": ClearedEnum.Cleared,
                    "approved": true,
                    "flag_color": FlagColorEnum.Blue
                });
            }
        }
    });

    return bulkTransactions;
}

(async () => {
    try {
        await run();
    } catch (err) {
        console.log(err);
        process.exit(1);
    }

    process.exit(0);
})();