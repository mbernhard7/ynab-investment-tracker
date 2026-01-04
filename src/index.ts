import {Account, API, BulkTransactions, TransactionsResponseData} from "ynab";
import YahooFinance from "yahoo-finance2";
import {TransactionFlagColor} from "ynab/dist/models/TransactionFlagColor";
import {TransactionClearedStatus} from "ynab/dist/models/TransactionClearedStatus";
import {QuoteResponseArray} from "yahoo-finance2/esm/src/modules/quote";

type THoldings = Map<string, { count: number, value: number }>;

export const run = async () => {
    const yf = new YahooFinance();
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
            const quotes: QuoteResponseArray = await yf.quote(symbolsToFetch, {fields: ["regularMarketPrice"]});
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
            tx.memo.split(",").forEach((item) => {
                console.log(`       [${item.split("|")[0]}] $${Number(item.split("|")[1]) / 1000}`);
            })
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

const isTransferOut = (t: {
    transfer_account_id?: string,
    amount: number
}): boolean => t?.transfer_account_id && t.amount < 0

const isStockUpdate = (t: { memo?: string }): boolean => t?.memo && t?.memo?.startsWith("$")

const updateHoldingCount = (ticker: string, count: number, holdings: THoldings): THoldings => {
    const holding = holdings.get(ticker) || {count: 0, value: 0};
    holding.count = holding.count + count;
    holdings.set(ticker, holding);
    return holdings
}

const updateHoldingValue = (ticker: string, value: number, holdings: THoldings): THoldings => {
    const holding = holdings.get(ticker) || {count: 0, value: 0};
    holding.value = holding.value + value;
    holdings.set(ticker, holding);
    return holdings
}

const buildAccountHoldingsFromTransactions = (data: TransactionsResponseData): THoldings => {
    let accountHoldings: THoldings = new Map();

    const transactions = data.transactions.map(t => {
        return {...t, date: Date.parse(t.date)};
    });

    console.log(`[YNIT] Processing transactions...`);

    transactions.forEach(t => {
        if (t.payee_name === "Bulk Investment Value Update") {
            t?.memo.split(",").forEach((item) => {
                const [ticker, amount] = item.replace("$", "").split("|")
                accountHoldings = updateHoldingValue(ticker, Number(amount) / 1000, accountHoldings);
            })
        } else if (!isTransferOut(t) && isStockUpdate(t)) {
            const [ticker, action] = t.memo.replace("$", "").split("|")
            accountHoldings = updateHoldingValue(ticker, t.amount / 1000, accountHoldings);
            const holding = accountHoldings.get(ticker) || {count: 0, value: 0};
            if (action.startsWith("BUY")) {
                holding.count = holding.count + +action.split(" ")[1];
                if (!t?.transfer_account_id) {
                    accountHoldings = updateHoldingCount("CASH", -t.amount / 1000, accountHoldings);
                }
            }
            if (action.startsWith("SELL")) {
                if (action.endsWith("ALL")) {
                    holding.count = 0
                } else {
                    holding.count = holding.count - +action.split(" ")[1];
                }
                accountHoldings = updateHoldingCount("CASH", -t.amount / 1000, accountHoldings);
            }
            accountHoldings.set(ticker, holding);
        } else {
            accountHoldings = updateHoldingCount("CASH", (t.amount / 1000), accountHoldings);
            accountHoldings = updateHoldingValue("CASH", (t.amount / 1000), accountHoldings);
        }
    });
    console.log(`[YNIT] Transactions processed.`);
    return accountHoldings;
}

const buildUpdateTransactionsFromQuotesAndHoldings = (account: Account, quotes: QuoteResponseArray, holdings: THoldings) => {
    const groupedTransactions: BulkTransactions = {transactions: []};
    const currentDate = new Date();
    const offset = currentDate.getTimezoneOffset();

    holdings.forEach(({count, value}, ticker) => {
        const quote = ticker === "CASH" ? {regularMarketPrice: 1} : quotes.find(k => k.symbol === ticker);
        if (!quote?.regularMarketPrice) {
            console.log(`[WARNING] Failed to get quote for: ${ticker}`);
        } else {
            const difference = Math.round(((quote.regularMarketPrice * count) - value) * 1000)

            if (difference !== 0) {
                const memo = `$${ticker}|`
                const last = groupedTransactions.transactions[groupedTransactions.transactions.length - 1]
                if (!last || last.memo.length + memo.length + 1 >= 500) {
                    groupedTransactions.transactions.push({
                        "account_id": account.id,
                        "date": new Date(currentDate.getTime() - (offset * 60 * 1000)).toISOString().split("T")[0],
                        "amount": difference,
                        "payee_name": `Bulk Investment Value Update`,
                        "memo": `$${ticker}|${difference}`,
                        "cleared": TransactionClearedStatus.Cleared,
                        "approved": true,
                        "flag_color": TransactionFlagColor.Blue
                    });
                } else {
                    groupedTransactions.transactions[groupedTransactions.transactions.length - 1] = {
                        ...last,
                        amount: last.amount + difference,
                        memo: `${last.memo},$${ticker}|${difference}`
                    }
                }
            }
        }
    })
    return groupedTransactions
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