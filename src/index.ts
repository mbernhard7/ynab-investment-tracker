import {Account, API, BulkTransactions, TransactionsResponseData} from "ynab";
import yahooFinance from "yahoo-finance2";
import {QuoteResponseArray} from "yahoo-finance2/dist/esm/src/modules/quote";
import {TransactionFlagColor} from "ynab/dist/models/TransactionFlagColor";
import {TransactionClearedStatus} from "ynab/dist/models/TransactionClearedStatus";

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

        const accountsWithHoldings = await Promise.all(investmentAccounts.map(async account => {
                const holdings = await processAccount(ynabAPI, budgetID, account)
                return {account, holdings}
            }
        ));

        const symbolsToFetch = []
        accountsWithHoldings.forEach(({holdings}) => {
            [...holdings.keys()].forEach(k => {
                if (k !== "CASH" && symbolsToFetch.find(j => j === k) === undefined) {
                    symbolsToFetch.push(k)
                }
            })
        })

        if (symbolsToFetch.length) {
            console.log(`[YNIT] Fetching quotes for: ${symbolsToFetch}`);
            const quotes: QuoteResponseArray = await yahooFinance.quote(symbolsToFetch, {fields: ["regularMarketPrice"]});
            console.log(`[YNIT] Fetched quotes.`);
            console.log(`[YNIT] Current prices:`);
            quotes.forEach((q) => {
                console.log(`       [${q.symbol}] Price: ${q.regularMarketPrice}`);
            });

            const bulkTransactions = await Promise.all(accountsWithHoldings.map(async ({
                                                                                           account,
                                                                                           holdings
                                                                                       }) => await buildUpdates(account, holdings, quotes)))

            const mergedTransactions = bulkTransactions.reduce(({transactions: at}, {transactions: vt}) => ({transactions: [...at, ...vt]}), {transactions: []})

            if (mergedTransactions.transactions.length) {
                console.log(`[YNIT] Posting transactions to YNAB...`);
                await ynabAPI.transactions.createTransactions(budgetID, mergedTransactions);
                console.log(`[YNIT] Posted transactions.`);
            }
        } else {
            console.log(`[YNIT] No symbols to fetch.`);
        }
    }
}

const buildUpdates = async (account: Account, accountHoldings: THoldings, quotes: QuoteResponseArray) => {
    const bulkTransactions = buildUpdateTransactionsFromQuotesAndHoldings(account, quotes, accountHoldings)

    if (bulkTransactions.transactions.length === 0) {
        console.log(`[YNIT] No updates needed for ${account.name}.`);
    } else {
        console.log(`[YNIT] Updates for ${account.name}:`);
        bulkTransactions.transactions.forEach((tx) => {
            console.log(`       [${tx.memo}] $${tx.amount / 1000}`);
        });
    }
    return bulkTransactions
}

const processAccount = async (ynabAPI: API, budgetID: string, account: Account) => {
    console.log(`[YNIT] Processing account ${account.name}...`);

    console.log(`[YNIT] Fetching transactions...`);
    const {data} = await ynabAPI.transactions.getTransactionsByAccount(budgetID, account.id);
    console.log(`[YNIT] Fetched ${data.transactions.length} transactions.`);

    const accountHoldings = buildAccountHoldingsFromTransactions(data)

    console.log(`[YNIT] Current holdings for ${account.name}:`);
    accountHoldings.forEach(({count, value}, ticker) => {
        console.log(`       [${ticker}] Shares: ${count} Value: $${value}`);
    });
    return accountHoldings
}

const buildAccountHoldingsFromTransactions = (data: TransactionsResponseData): THoldings => {
    const accountHoldings: THoldings = new Map();

    const transactions = data.transactions.map(t => {
        return {...t, date: Date.parse(t.date)};
    });

    console.log(`[YNIT] Processing transactions...`);

    transactions.forEach(t => {
        if (t?.memo && t?.memo?.startsWith("$")) {
            const [ticker, action] = t.memo.replace("$", "").split("|")
            const holding = accountHoldings.get(ticker) || {count: 0, value: 0};
            holding.value = holding.value + (t.amount / 1000);
            if (action.startsWith("BUY")) {
                holding.count = holding.count + +action.split(" ")[1];
            }
            if (action.startsWith("SELL")) {
                holding.count = holding.count - +action.split(" ")[1];
            }
            if (holding.count !== 0) {
                accountHoldings.set(ticker, holding);
            } else if (accountHoldings.has(ticker)) {
                delete accountHoldings[ticker]
            }
        } else {
            const holding = accountHoldings.get("CASH") || {count: 0, value: 0};
            holding.value = holding.value + (t.amount / 1000);
            accountHoldings.set("CASH", holding);
        }
    });

    console.log(`[YNIT] Transactions processed.`);
    return accountHoldings;
}

const buildUpdateTransactionsFromQuotesAndHoldings = (account: Account, quotes: QuoteResponseArray, holdings: THoldings): BulkTransactions => {
    const bulkTransactions: BulkTransactions = {transactions: []};
    const currentDate = new Date();
    const offset = currentDate.getTimezoneOffset();

    holdings.forEach(({count, value}, ticker) => {
        const quote = quotes.find(k => k.symbol === ticker);
        if (!quote?.regularMarketPrice) {
            if (ticker !== "CASH") {
                console.log(`[WARNING] Failed to get quote for: ${ticker}`);
            }
        } else {
            const difference = (quote.regularMarketPrice * count) - value;

            if (Math.round(difference * 1000) !== 0) {

                bulkTransactions.transactions.push({
                    "account_id": account.id,
                    "date": new Date(currentDate.getTime() - (offset * 60 * 1000)).toISOString().split("T")[0],
                    "amount": Math.round(difference * 1000),
                    "payee_name": `Investment Value Update`,
                    "memo": `$${ticker}|VALUE_UPDATE`,
                    "cleared": TransactionClearedStatus.Cleared,
                    "approved": true,
                    "flag_color": TransactionFlagColor.Blue
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