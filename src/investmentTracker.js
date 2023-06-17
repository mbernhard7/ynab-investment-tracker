"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = void 0;
const ynab_1 = require("ynab");
const yahoo_finance2_1 = __importDefault(require("yahoo-finance2"));
var ClearedEnum = ynab_1.SaveTransaction.ClearedEnum;
var FlagColorEnum = ynab_1.SaveTransaction.FlagColorEnum;
const run = async () => {
    if (!process.env?.YNAB_API_TOKEN || !process.env?.YNAB_BUDGET_ID) {
        throw "Missing environment variables";
    }
    else {
        const budgetID = process.env.YNAB_BUDGET_ID;
        const ynabAPI = new ynab_1.API(process.env.YNAB_API_TOKEN);
        console.log(`[INFO] Fetching budget...`);
        const { data: { budget } } = await ynabAPI.budgets.getBudgetById(budgetID);
        console.log(`[INFO] Fetched.`);
        console.log(`[INFO] Fetching accounts...`);
        const { data: { accounts } } = await ynabAPI.accounts.getAccounts(budget.id);
        console.log(`[INFO] Fetched ${accounts.length} accounts.`);
        const investmentAccounts = accounts.filter((account) => account?.note?.includes("INVESTMENT_TO_TRACK"));
        console.log(`[INFO] ${investmentAccounts} investment accounts found.`);
        await Promise.all(investmentAccounts.map(account => processAccount(ynabAPI, budgetID, account)));
    }
};
exports.run = run;
const processAccount = async (ynabAPI, budgetID, account) => {
    console.log(`[INFO] Processing account ${account.name}...`);
    console.log(`[INFO] Fetching transactions...`);
    const { data } = await ynabAPI.transactions.getTransactionsByAccount(budgetID, account.id);
    console.log(`[INFO] Fetched ${data.transactions.length} transactions.`);
    const accountHoldings = buildAccountHoldingsFromTransactions(data);
    console.log(`[INFO] Current holdings:`);
    accountHoldings.forEach(({ count, value }, ticker) => {
        console.log(`       [${ticker}] Shares: ${count} Value: $${value}`);
    });
    console.log(`[INFO] Fetching quotes...`);
    const quotes = await yahoo_finance2_1.default.quote(Array.from(accountHoldings.keys()), { fields: ["regularMarketPrice"], return: "map" });
    console.log(`[INFO] Fetched quotes.`);
    const bulkTransactions = buildUpdateTransactionsFromQuotesAndHoldings(account, quotes, accountHoldings);
    if (bulkTransactions.transactions.length === 0) {
        console.log(`[INFO] No updates needed.`);
    }
    else {
        console.log(`[INFO] Updates:`);
        bulkTransactions.transactions.forEach((tx) => {
            console.log(`       [${tx.payee_name}] $${tx.amount}`);
        });
        console.log(`[INFO] Posting transactions to YNAB...`);
        await ynabAPI.transactions.bulkCreateTransactions(budgetID, bulkTransactions);
        console.log(`[INFO] Posted transactions.`);
    }
};
const buildAccountHoldingsFromTransactions = (data) => {
    const accountHoldings = new Map();
    const transactions = data.transactions.map(t => {
        return { ...t, date: Date.parse(t.date) };
    });
    console.log(`[INFO] Processing transactions...`);
    transactions.forEach(t => {
        if (t?.payee_name && t?.payee_name?.startsWith("$")) {
            const ticker = t.payee_name.replace("$", "").trim();
            const holding = accountHoldings.get(ticker) || { count: 0, value: 0 };
            holding.value = holding.value + t.amount;
            if (t?.memo && t?.memo?.startsWith("BUY")) {
                holding.count = holding.count + +t.memo.split(" ")[1];
            }
            if (t?.memo && t?.memo?.startsWith("SELL")) {
                holding.count = holding.count - +t.memo.split(" ")[1];
            }
            accountHoldings.set(ticker, holding);
        }
    });
    console.log(`[INFO] Transactions processed.`);
    return accountHoldings;
};
const buildUpdateTransactionsFromQuotesAndHoldings = (account, quotes, holdings) => {
    const bulkTransactions = { transactions: [] };
    const currentDate = new Date();
    const offset = currentDate.getTimezoneOffset();
    holdings.forEach(({ count, value }, ticker) => {
        const quote = quotes.get(ticker);
        if (!quote?.regularMarketPrice) {
            console.log(`[WARNING] Failed to get quote for: ${ticker}`);
        }
        else {
            const difference = (quote.regularMarketPrice * count) - value;
            if (difference !== 0) {
                console.log(`[INFO] Creating update transaction for ${ticker} of $${difference} in ${account.name}`);
                bulkTransactions.transactions.push({
                    "account_id": account.id,
                    "date": new Date(currentDate.getTime() - (offset * 60 * 1000)).toISOString().split('T')[0],
                    "amount": difference,
                    "payee_name": `$${ticker}`,
                    "memo": "PRICE CHANGE",
                    "cleared": ClearedEnum.Cleared,
                    "approved": true,
                    "flag_color": FlagColorEnum.Blue
                });
            }
        }
    });
    return bulkTransactions;
};
