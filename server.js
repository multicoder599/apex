require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const bcrypt = require('bcryptjs'); 
const http = require('http');

const app = express();
const server = http.createServer(app); 

// ==========================================
// CORS CONFIGURATION
// ==========================================
app.use(cors({
    origin: "*", 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: false 
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ENVIRONMENT VARIABLES
// ==========================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MONGO_URI = process.env.MONGO_URI;
const ODDS_API_KEY = process.env.ODDS_API_KEY; 

// ==========================================
// TELEGRAM BOT UTILITY (For Admin Alerts)
// ==========================================
function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        .catch(err => console.error("Telegram Notification Error:", err.message));
}

// ==========================================
// MONGODB CONNECTION & MODELS
// ==========================================
mongoose.connect(MONGO_URI)
  .then(() => {
      console.log('✅ Connected to MongoDB successfully!');
      initVirtualsEngine(); // 🟢 NEW: Start Virtuals Engine upon DB connection
  })
  .catch(err => console.error('❌ MongoDB connection error:', err));

const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    bonusBalance: { type: Number, default: 0 },
    referredBy: { type: String, default: null }, 
    notifications: { type: Array, default: [] }, // 🟢 NEW: Embedded Notifications Array
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 🟢 FIX: Removed strict enums & added defaults to prevent My Bets crashes
const betSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    stake: { type: Number, required: true },
    potentialWin: { type: Number, default: 0 }, 
    selections: { type: Array, default: [] }, 
    type: { type: String, default: 'Sports' }, 
    status: { type: String, default: 'Open' }, 
    createdAt: { type: Date, default: Date.now }
});
const Bet = mongoose.model('Bet', betSchema);

// 🟢 FIX: Removed strict enums for generic transaction types
const transactionSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true }, 
    userPhone: { type: String, required: true },
    type: { type: String, required: true }, 
    method: { type: String, required: true },
    amount: { type: Number, required: true }, 
    status: { type: String, default: 'Success' }, 
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const liveGameSchema = new mongoose.Schema({
    id: Number, category: String, home: String, away: String,
    odds: String, draw: String, away_odds: String, time: String,
    status: { type: String, default: 'upcoming' }
}, { strict: false }); 
const LiveGame = mongoose.model('LiveGame', liveGameSchema);

// 🟢 NEW: VIRTUALS DB MODEL
const virtualStateSchema = new mongoose.Schema({
    seasonId: { type: String, required: true, unique: true },
    currentSeason: Number,
    rounds: Array,
    standingsData: Array,
    resultsData: Array,
    updatedAt: { type: Date, default: Date.now }
});
const VirtualState = mongoose.model('VirtualState', virtualStateSchema);

// 🟢 NEW: FIXED GAMES DB MODEL FOR PRE-DETERMINED SETTLEMENTS
const fixedGameSchema = new mongoose.Schema({
    matchName: { type: String, required: true }, // e.g. "Arsenal vs Chelsea"
    result_1x2: { type: String }, // '1', 'X', or '2'
    result_ou25: { type: String }, // 'Over' or 'Under'
    result_ggng: { type: String }, // 'GG' or 'NG'
    ft_score: { type: String }, // e.g. "2-1"
    createdAt: { type: Date, default: Date.now }
});
const FixedGame = mongoose.model('FixedGame', fixedGameSchema);

// ==========================================
// 🟢 NOTIFICATIONS (EMBEDDED DB LOGIC)
// ==========================================
app.get('/api/notifications/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        const unreadNotifs = user.notifications.filter(n => n.isRead === false);

        if (unreadNotifs.length > 0) {
            user.notifications.forEach(n => n.isRead = true);
            user.markModified('notifications'); 
            await user.save();
        }
        res.json({ success: true, notifications: unreadNotifs.slice().reverse() });
    } catch (e) { 
        res.status(500).json({ success: false }); 
    }
});

async function sendPushNotification(phone, title, message, type) {
    try {
        let formattedPhone = phone.replace(/\D/g, '');
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const notifObj = {
            id: "N-" + Date.now() + Math.floor(Math.random() * 1000),
            title: title,
            message: message,
            type: type,
            isRead: false,
            createdAt: new Date()
        };

        await User.updateMany(
            { $or: [{ phone: phone }, { phone: formattedPhone }] },
            { $push: { notifications: notifObj } }
        );
    } catch(e) { console.error("Notification Save Error", e); }
}


// ==========================================
// AUTHENTICATION & REFERRAL ENDPOINTS
// ==========================================
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name, ref } = req.body;
        if (!phone || !password) return res.status(400).json({ success: false, message: 'Phone and password are required.' });

        const existingUser = await User.findOne({ phone });
        if (existingUser) return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });

        let referredByPhone = null;
        if (ref) {
            const cleanRef = ref.replace('APX-', '');
            const allUsers = await User.find({});
            const referrer = allUsers.find(u => Buffer.from(u.phone).toString('base64').substring(0, 8).toUpperCase() === cleanRef);
            if (referrer) referredByPhone = referrer.phone;
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ phone, password: hashedPassword, name: name || 'New Player', balance: 0, bonusBalance: 0, referredBy: referredByPhone });
        await newUser.save();

        sendTelegramMessage(`🚨 <b>NEW USER REGISTRATION</b> 🚨\n\n👤 <b>Name:</b> ${newUser.name}\n📱 <b>Phone:</b> ${newUser.phone}\n🔗 <b>Referred By:</b> ${referredByPhone || 'None'}`);
        res.json({ success: true, user: { name: newUser.name, balance: newUser.balance, bonusBalance: newUser.bonusBalance, phone: newUser.phone } });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(401).json({ success: false, message: 'Invalid phone number or password' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            if (password === user.password) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(password, salt);
                await user.save();
            } else {
                return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
            }
        }
        res.json({ success: true, user: { name: user.name, balance: user.balance, bonusBalance: user.bonusBalance || 0, phone: user.phone } });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error' }); }
});


// ==========================================
// FINANCE: DEPOSIT, WITHDRAWAL & BONUS
// ==========================================
app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        if (amount < 10) return res.status(400).json({ success: false, message: 'Minimum deposit is 10 KES.' });

        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        let formattedPhone = userPhone.replace(/\D/g, ''); 
        if (formattedPhone.startsWith('0')) formattedPhone = '254' + formattedPhone.substring(1);
        if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) formattedPhone = '254' + formattedPhone;

        const APP_URL = process.env.APP_URL || 'https://apex-efwz.onrender.com';
        const reference = "DEP" + Date.now();

        const payload = {
            api_key: "MGPY26G5iWPw", 
            email: "kanyingiwaitara@gmail.com", 
            amount: amount, 
            msisdn: formattedPhone,
            callback_url: `${APP_URL}/api/megapay/webhook`,
            description: "ApexBet Deposit", 
            reference: reference
        };

        await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        await Transaction.create({ refId: reference, userPhone: user.phone, type: 'deposit', method: method || 'M-Pesa', amount: Number(amount), status: 'Pending' });

        res.status(200).json({ success: true, message: "STK Push Sent! Check your phone.", newBalance: user.balance, refId: reference });
    } catch (error) { res.status(500).json({ success: false, message: "Payment Gateway Error. Please try again." }); }
});

app.post('/api/megapay/webhook', async (req, res) => {
    res.status(200).send("OK");
    const data = req.body;
    try {
        const responseCode = data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode;
        if (responseCode != 0) return; 

        const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
        const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
        let rawPhone = (data.Msisdn || data.phone || data.PhoneNumber).toString();
        
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: phone0 }, { phone: phone254 }, { phone: rawPhone }] });
        if (!user) {
            console.error(`Webhook user not found for phone: ${rawPhone}`);
            return;
        }

        const existingTx = await Transaction.findOne({ refId: receipt });
        if (existingTx) return;

        user.balance += amount;
        await user.save();

        await Transaction.create({ refId: receipt, userPhone: user.phone, type: "deposit", method: "M-Pesa", amount: amount, status: "Success" });

        sendPushNotification(user.phone, "Deposit Successful", `Your deposit of KES ${amount} has been credited.`, "deposit");
        sendTelegramMessage(`✅ <b>DEPOSIT CONFIRMED</b> ✅\n\n👤 <b>User:</b> ${user.phone}\n💰 <b>Amount:</b> KES ${amount}\n🧾 <b>Receipt:</b> ${receipt}`);

        if (user.referredBy) {
            const referrer = await User.findOne({ phone: user.referredBy });
            if (referrer) {
                referrer.bonusBalance = (referrer.bonusBalance || 0) + 50;
                await referrer.save();

                await Transaction.create({ refId: `REF-BONUS-${receipt}`, userPhone: referrer.phone, type: "bonus", method: "Referral Deposit Bonus", amount: 50, status: "Success" });
                sendPushNotification(referrer.phone, "Referral Bonus! 🎁", `Your friend made a deposit! KES 50 has been added to your Bonus Wallet.`, "bonus");
            }
        }
    } catch (err) { console.error("Webhook Processing Error:", err); }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        
        if (user.balance < amount) {
            return res.status(400).json({ success: false, message: 'Insufficient withdrawable funds.' });
        }

        user.balance -= Number(amount);
        await user.save();

        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone, type: 'withdraw', method, amount: -Number(amount), status: 'Success' });

        sendPushNotification(user.phone, "Withdrawal Sent", `KES ${amount} has been sent to your M-Pesa.`, "withdraw");
        sendTelegramMessage(`💸 <b>WITHDRAWAL REQUEST</b> 💸\n\n👤 <b>User:</b> ${user.phone}\n💰 <b>Amount:</b> KES ${amount}\n🧾 <b>Ref:</b> ${refId}`);

        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) { res.status(500).json({ success: false, message: 'Withdrawal processing failed' }); }
});

app.get('/api/balance/:phone', async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, balance: user.balance, bonusBalance: user.bonusBalance || 0 });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error fetching balance' }); }
});

app.get('/api/transactions/:phone', async (req, res) => {
    try {
        const txns = await Transaction.find({ userPhone: req.params.phone }).sort({ createdAt: -1 });
        res.json({ success: true, transactions: txns });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to fetch transactions' }); }
});


// ==========================================
// PING TEST ENDPOINT (FOR CRON-JOB.ORG)
// ==========================================
app.get('/api/test', (req, res) => {
    res.json({ success: true, message: "Server is awake!" });
});


// ==========================================
// SPORTS BETTING ENDPOINTS
// ==========================================
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin, betType } = req.body;
        const user = await User.findOne({ phone: userPhone });

        const totalAvailable = user.balance + (user.bonusBalance || 0);

        if (!user || totalAvailable < stake) return res.status(400).json({ success: false, message: 'Insufficient funds! Please deposit.' });

        let remainingStake = stake;
        if (user.bonusBalance >= remainingStake) {
            user.bonusBalance -= remainingStake; 
            remainingStake = 0;
        } else {
            remainingStake -= user.bonusBalance; 
            user.bonusBalance = 0;
            user.balance -= remainingStake; 
        }
        await user.save();

        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        
        // 🟢 Ensure each selection has a default status of Pending and captures startTime
        const mappedSelections = selections.map(s => ({
            ...s,
            status: 'Pending',
            startTime: s.startTime || Date.now() 
        }));

        const newBet = new Bet({ ticketId, userPhone, stake, potentialWin, selections: mappedSelections, type: betType || 'Sports' });
        await newBet.save();

        await Transaction.create({ refId: ticketId, userPhone, type: 'bet', method: `${betType || 'Sports'} Bet`, amount: -stake });

        res.json({ success: true, newBalance: user.balance, newBonus: user.bonusBalance, ticketId: newBet.ticketId });
    } catch (error) { res.status(500).json({ success: false, message: 'Bet placement failed' }); }
});

app.get('/api/bets/:phone', async (req, res) => {
    try {
        const bets = await Bet.find({ userPhone: req.params.phone }).sort({ createdAt: -1 });
        res.json({ success: true, bets });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to fetch betting history' }); }
});

app.post('/api/cashout', async (req, res) => {
    try {
        const { ticketId, userPhone, amount } = req.body;
        
        if (ticketId && ticketId.startsWith('AV-')) {
            const user = await User.findOne({ phone: userPhone });
            if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
            
            user.balance += amount;
            await user.save();
            
            // Mark Aviator bet as Cashed Out
            await Bet.updateOne({ ticketId: ticketId }, { $set: { status: 'Cashed Out' } });

            await Transaction.create({ refId: ticketId + '-WIN', userPhone, type: 'win', method: 'Aviator Win', amount: amount });
            sendPushNotification(user.phone, "Aviator Cashout! ✈️", `You successfully cashed out KES ${amount.toFixed(2)}.`, "cashout");
            
            return res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
        }

        const bet = await Bet.findOne({ ticketId: ticketId, userPhone: userPhone });
        if (!bet) return res.status(404).json({ success: false, message: 'Ticket not found.' });
        if (bet.status !== 'Open') return res.status(400).json({ success: false, message: 'Ticket is already settled.' });

        const user = await User.findOne({ phone: userPhone });
        
        bet.status = 'Cashed Out';
        await bet.save();

        user.balance += amount;
        await user.save();

        await Transaction.create({ refId: `CO-${ticketId}`, userPhone, type: 'cashout', method: 'Cashout', amount: amount });

        sendPushNotification(user.phone, "Bet Cashed Out", `You successfully cashed out KES ${amount}.`, "cashout");
        res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error processing cashout' }); }
});


// ==========================================
// 🟢 REALISTIC BACKGROUND BET SETTLEMENT (SPORTS & JACKPOT)
// ==========================================
setInterval(async () => {
    try {
        // Fetch open bets excluding virtuals and aviator
        const openBets = await Bet.find({ status: 'Open', type: { $nin: ['Aviator', 'Virtuals'] } });
        const fixedGames = await FixedGame.find({});
        const now = Date.now();

        for (let bet of openBets) {
            let allFinished = true;
            let hasLost = false;
            let hasPending = false;

            // Iterate over every leg in the betslip or jackpot
            for (let sel of bet.selections) {
                if (sel.status === 'Won') continue; 
                if (sel.status === 'Lost') { hasLost = true; break; }

                // Match time + 2 Hours (120 mins) buffer for game to officially "finish"
                let startTime = sel.startTime || new Date(bet.createdAt).getTime();
                let endTime = startTime + (120 * 60 * 1000); 

                // If the current time is before the end time, this game is still playing
                if (now < endTime) {
                    allFinished = false;
                    hasPending = true;
                    continue; 
                }

                // Game has finished playing, grade it!
                let isWin = false;
                let fixedMatch = fixedGames.find(fg => fg.matchName === sel.match);

                if (fixedMatch) {
                    // Use predefined Admin results
                    if (sel.market === '1X2' || sel.market === 'Jackpot Result') isWin = (sel.pick === fixedMatch.result_1x2);
                    else if (sel.market === 'O/U 2.5') isWin = (sel.pick === fixedMatch.result_ou25);
                    else if (sel.market === 'GG/NG') isWin = (sel.pick === fixedMatch.result_ggng);
                    else isWin = (sel.pick === fixedMatch.result_1x2); // fallback
                } else {
                    // Normal match without fixed outcome: 40% win rate
                    isWin = Math.random() < 0.40;
                }

                sel.status = isWin ? 'Won' : 'Lost';
                bet.markModified('selections'); // Save embedded array change

                if (!isWin) {
                    hasLost = true;
                    break; // If one game loses, the entire multi-bet / jackpot loses immediately
                }
            }

            // Decide Final Ticket Status
            if (hasLost) {
                bet.status = 'Lost';
                await bet.save();
                sendPushNotification(bet.userPhone, "Bet Lost 😔", `Ticket ${bet.ticketId} lost. Better luck next time!`, "bet");
            
            } else if (allFinished && !hasPending) {
                // Every single match finished and won
                bet.status = 'Won';
                await bet.save();
                
                const user = await User.findOne({ phone: bet.userPhone });
                if (user) {
                    user.balance += bet.potentialWin;
                    await user.save();
                    
                    await Transaction.create({ 
                        refId: `WIN-${bet.ticketId}`, 
                        userPhone: user.phone, 
                        type: 'win', 
                        method: 'Bet Winnings', 
                        amount: bet.potentialWin 
                    });
                    
                    sendPushNotification(user.phone, "Bet Won! 🥳", `Ticket ${bet.ticketId} won! KES ${bet.potentialWin} added to your balance.`, "win");
                }
            }
        }
    } catch (error) { 
        console.error("Realistic Settlement Error:", error.message); 
    }
}, 60 * 1000); // Check every minute


// ==========================================
// ADMIN ROUTES & PUSH ALERTS
// ==========================================
app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}).select('-password').sort({ createdAt: -1 });
        res.json({ success: true, users });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to fetch users' }); }
});

app.put('/api/admin/users/balance', async (req, res) => {
    try {
        const { phone, newBalance } = req.body;
        const user = await User.findOne({ phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const oldBalance = user.balance;
        user.balance = Number(newBalance);
        await user.save();

        await Transaction.create({ refId: 'ADMIN-' + Math.floor(Math.random() * 900000), userPhone: phone, type: 'bonus', method: 'Admin Adjustment', amount: user.balance - oldBalance, status: 'Success' });
        res.json({ success: true, message: `Balance updated to KES ${user.balance}.` });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to update user balance' }); }
});

app.delete('/api/admin/users/:phone', async (req, res) => {
    try {
        const user = await User.findOneAndDelete({ phone: req.params.phone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        res.json({ success: true, message: `Account deleted.` });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to delete user account' }); }
});

app.post('/api/admin/push-alert', async (req, res) => {
    try {
        const { phone, title, message } = req.body;
        
        if (phone === 'ALL') {
            const bObj = { id: "BC-" + Date.now(), title, message, type: 'admin_alert', isRead: false, createdAt: new Date() };
            await User.updateMany({}, { $push: { notifications: bObj } });
        } else {
            await sendPushNotification(phone, title, message, 'admin_alert');
        }
        
        res.json({success: true, message: "Alert successfully dispatched!"});
    } catch(e) {
        res.status(500).json({success: false, message: e.message});
    }
});

// 🟢 NEW: Fixed Games Endpoints
app.post('/api/admin/fixed-games', async (req, res) => {
    try {
        await FixedGame.insertMany(req.body.games);
        res.json({ success: true, message: "Fixed games injected successfully." });
    } catch(e) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/fixed-games', async (req, res) => {
    try {
        const games = await FixedGame.find({});
        res.json({ success: true, games });
    } catch(e) { res.status(500).json({ success: false }); }
});

app.delete('/api/admin/fixed-games', async (req, res) => {
    try {
        await FixedGame.deleteMany({});
        res.json({ success: true, message: "Fixed games cleared." });
    } catch(e) { res.status(500).json({ success: false }); }
});

app.post('/api/games', async (req, res) => {
    try {
        const { games, mode } = req.body;
        if (mode === 'replace') await LiveGame.deleteMany({}); 
        await LiveGame.insertMany(games); 
        res.json({ success: true, message: "Games updated in database" });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to inject games' }); }
});

app.delete('/api/games', async (req, res) => {
    try {
        await LiveGame.deleteMany({});
        res.json({ success: true, message: "Global database cleared" });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to clear database' }); }
});

// ==========================================
// UNIFIED GAMES ENDPOINT (REAL DATE FIX)
// ==========================================
let cachedApiGames = [];
let lastApiFetchTime = 0;
const API_CACHE_DURATION = 5 * 60 * 1000;

app.get('/api/games', async (req, res) => {
    try {
        const dbGamesRaw = await LiveGame.find({});
        let allGames = dbGamesRaw.map(g => g.toObject());

        if (ODDS_API_KEY && ODDS_API_KEY !== 'undefined') {
            const now = Date.now();
            
            if (now - lastApiFetchTime > API_CACHE_DURATION || cachedApiGames.length === 0) {
                try {
                    const [eplRes, ligaRes, upcomingRes] = await Promise.allSettled([
                        axios.get(`https://api.the-odds-api.com/v4/sports/soccer_epl/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } }),
                        axios.get(`https://api.the-odds-api.com/v4/sports/soccer_spain_la_liga/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } }),
                        axios.get(`https://api.the-odds-api.com/v4/sports/upcoming/odds/`, { params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' } })
                    ]);

                    let rawApiGames = [];
                    if (eplRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...eplRes.value.data];
                    if (ligaRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...ligaRes.value.data];
                    if (upcomingRes.status === 'fulfilled') rawApiGames = [...rawApiGames, ...upcomingRes.value.data];

                    const uniqueGamesMap = new Map();
                    rawApiGames.forEach(g => { if (!uniqueGamesMap.has(g.id)) uniqueGamesMap.set(g.id, g); });
                    const uniqueGames = Array.from(uniqueGamesMap.values());

                    cachedApiGames = uniqueGames.map(m => {
                        let h = "0.00", d = null, a = "0.00";
                        if (m.bookmakers && m.bookmakers.length > 0) {
                            const markets = m.bookmakers[0].markets;
                            const h2h = markets.find(mk => mk.key === 'h2h');
                            if (h2h && h2h.outcomes) {
                                const outHome = h2h.outcomes.find(o => o.name === m.home_team);
                                const outAway = h2h.outcomes.find(o => o.name === m.away_team);
                                const outDraw = h2h.outcomes.find(o => o.name.toLowerCase() === 'draw');
                                if(outHome) h = outHome.price.toFixed(2);
                                if(outAway) a = outAway.price.toFixed(2);
                                if(outDraw) d = outDraw.price.toFixed(2);
                            }
                        }

                        const nH = parseFloat(h);
                        const nA = parseFloat(a);
                        if (nH < 1.05 || nA < 1.05 || nH > 50 || nA > 50) return null;
                        if (m.sport_title.toLowerCase().includes('soccer') && !d) return null;

                        const matchTime = new Date(m.commence_time);
                        const diffMins = Math.floor((now - matchTime.getTime()) / 60000);
                        
                        let status = "upcoming", min = null, hs = 0, as = 0;
                        
                        // 🟢 FIX: Formatted Date and Time for real games
                        let rawTime = matchTime.toLocaleTimeString('en-GB', {hour: '2-digit', minute:'2-digit', timeZone: 'Africa/Nairobi'});
                        let rawDate = matchTime.toLocaleDateString('en-GB', {day: 'numeric', month: 'short', timeZone: 'Africa/Nairobi'});

                        const matchDateEAT = new Date(matchTime.toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
                        const nowDateEAT = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));

                        if (diffMins > 120) return null; 

                        if (diffMins >= 0 && diffMins <= 115) {
                            status = "live";
                            rawTime = "Live";
                            min = diffMins > 45 && diffMins < 60 ? "HT" : diffMins > 90 ? "90+" : diffMins.toString() + "'";
                            
                            const homeAdv = (1 / nH) > (1 / nA) ? 1.5 : 0.5;
                            hs = Math.floor((diffMins / 90) * homeAdv * Math.random() * 4);
                            as = Math.floor((diffMins / 90) * (2 - homeAdv) * Math.random() * 4);
                            
                        } else if (matchDateEAT.getDate() === nowDateEAT.getDate() && matchDateEAT.getMonth() === nowDateEAT.getMonth()) {
                            status = "today";
                            rawTime = `Today, ${rawTime}`;
                        } else {
                            status = "upcoming";
                            rawTime = `${rawDate}, ${rawTime}`; 
                        }

                        return {
                            id: m.id, category: m.sport_title, league: m.sport_title, cc: 'INT',
                            home: m.home_team, away: m.away_team, odds: h, draw: d, away_odds: a,
                            time: rawTime, status: status, min: min, hs: hs, as: as,
                            commence_time: matchTime.getTime() 
                        };
                    }).filter(game => game !== null);

                    lastApiFetchTime = now;
                } catch (apiErr) {}
            }
            allGames = [...allGames, ...cachedApiGames];
        }
        res.json({ success: true, games: allGames });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to aggregate games' }); }
});

// ==========================================
// SERVER-SIDE VIRTUAL LEAGUE ENGINE
// ==========================================
const V_TEAMS = [
    { name: "Manchester Blue", color: "#6CABDD", short: "MCI" }, { name: "Manchester Reds", color: "#DA291C", short: "MUN" },
    { name: "Burnley", color: "#6C1D45", short: "BUR" }, { name: "Everton", color: "#003399", short: "EVE" },
    { name: "Sheffield U", color: "#EE2737", short: "SHU" }, { name: "London Blues", color: "#034694", short: "CHE" },
    { name: "Wolves", color: "#FDB913", short: "WOL" }, { name: "Liverpool", color: "#C8102E", short: "LIV" },
    { name: "West Ham", color: "#7A263A", short: "WHU" }, { name: "Leicester", color: "#003090", short: "LEI" },
    { name: "Newcastle", color: "#241F20", short: "NEW" }, { name: "Fulham", color: "#000000", short: "FUL" },
    { name: "Tottenham", color: "#132257", short: "TOT" }, { name: "Aston V", color: "#95BFE5", short: "AVL" },
    { name: "Palace", color: "#1B458F", short: "CRY" }, { name: "Leeds", color: "#FFCD00", short: "LEE" },
    { name: "West Brom", color: "#091453", short: "WBA" }, { name: "Southampton", color: "#D71920", short: "SOU" },
    { name: "Brighton", color: "#0057B8", short: "BHA" }, { name: "London Reds", color: "#E03A3E", short: "ARS" }
];

let vState = {
    seasonId: "INIT", currentSeason: 1, rounds: [], standingsData: [], resultsData: []
};
let vLoopActive = false;

async function initVirtualsEngine() {
    try {
        const dbState = await VirtualState.findOne();
        const now = Date.now();

        if (dbState && dbState.rounds && dbState.rounds.length > 0) {
            const lastRound = dbState.rounds[dbState.rounds.length - 1];
            if (now > lastRound.startTime + 120000) {
                await startNewVirtualSeason(dbState.currentSeason + 1);
            } else {
                vState = dbState.toObject();
            }
        } else {
            await startNewVirtualSeason(1);
        }

        if(!vLoopActive) {
            setInterval(runVirtualsLoop, 1000);
            vLoopActive = true;
            console.log(`🎮 Virtuals Engine Live (Season ${vState.currentSeason})`);
        }
    } catch(e) { console.error("Virtuals Init Error", e); }
}

async function startNewVirtualSeason(seasonNum) {
    const now = Date.now();
    let firstStart = now + 15000; 
    let newRounds = [];
    
    for(let i=1; i<=38; i++) {
        newRounds.push(generateVirtualRound(i, firstStart + ((i-1) * 120000))); 
    }
    
    vState.currentSeason = seasonNum;
    vState.seasonId = `S${seasonNum}-${now}`;
    vState.rounds = newRounds;
    vState.standingsData = V_TEAMS.map(t => ({ name: t.name, color: t.color, short: t.short, p: 0, pts: 0, gd: 0 })).sort((a,b) => a.name.localeCompare(b.name));
    vState.resultsData = [];
    
    await VirtualState.deleteMany({});
    await VirtualState.create(vState);
}

function generateVirtualEvents(homeProb) {
    let events = [], hs = 0, as = 0;
    for(let min = 1; min <= 90; min++) {
        if(Math.random() < 0.032) { 
            if(Math.random() < homeProb) { hs++; events.push({ min, type: 'home' }); } 
            else { as++; events.push({ min, type: 'away' }); }
        }
    }
    return { events, hs, as };
}

function generateVirtualRound(matchday, startTime) {
    let shuffled = [...V_TEAMS].sort(() => 0.5 - Math.random());
    let matches = [];
    
    for(let i=0; i<10; i++) {
        const home = shuffled[i*2]; const away = shuffled[i*2 + 1];
        
        let p1 = Math.random() * 0.4 + 0.25; 
        let p2 = Math.random() * 0.35 + 0.15; 
        let px = Math.max(0.15, 1 - (p1 + p2)); 
        
        const margin = 1.12; 
        const hBase = (1 / (p1 * margin)).toFixed(2);
        const dBase = (1 / (px * margin)).toFixed(2);
        const aBase = (1 / (p2 * margin)).toFixed(2);
        
        const sim = generateVirtualEvents(p1 / (p1 + p2));

        matches.push({
            id: `MD${matchday}-${i}`, home, away, hs: 0, as: 0, events: sim.events, hFlash: false, aFlash: false,
            odds: {
                '1X2': [ {lbl: '1', val: hBase}, {lbl: 'X', val: dBase}, {lbl: '2', val: aBase} ],
                'O/U 2.5': [ {lbl: 'Over', val: (1.6 + Math.random()*0.5).toFixed(2)}, {lbl: 'Under', val: (1.7 + Math.random()*0.5).toFixed(2)} ],
                'GG/NG': [ {lbl: 'GG', val: (1.65 + Math.random()*0.5).toFixed(2)}, {lbl: 'NG', val: (1.8 + Math.random()*0.5).toFixed(2)} ],
                'Double Chance': [ {lbl: '1X', val: (1.2 + Math.random()*0.2).toFixed(2)}, {lbl: '12', val: (1.3 + Math.random()*0.2).toFixed(2)}, {lbl: 'X2', val: (1.4 + Math.random()*0.3).toFixed(2)} ]
            }
        });
    }

    return { id: 'R' + matchday, matchday, startTime, status: 'BETTING', liveMin: "0'", currentMinNum: 0, matches };
}

async function runVirtualsLoop() {
    let now = Date.now();
    let needsSave = false;
    let seasonEnded = false;

    for (let r of vState.rounds) {
        let timeUntilLive = r.startTime - now;
        let oldStatus = r.status;

        if (timeUntilLive <= 0 && timeUntilLive > -55000) {
            r.status = 'LIVE';
            let elapsedLive = Math.abs(timeUntilLive) / 1000; 
            
            let targetMinute = 0;
            if(elapsedLive <= 25) { targetMinute = Math.floor((elapsedLive / 25) * 45); r.liveMin = targetMinute + "'"; }
            else if(elapsedLive > 25 && elapsedLive <= 30) { targetMinute = 45; r.liveMin = "HT"; }
            else { targetMinute = Math.floor(45 + ((elapsedLive - 30) / 25) * 45); r.liveMin = targetMinute + "'"; }

            r.currentMinNum = targetMinute;
            r.matches.forEach(m => {
                m.hs = m.events.filter(e => e.type === 'home' && e.min <= targetMinute).length;
                m.as = m.events.filter(e => e.type === 'away' && e.min <= targetMinute).length;
            });
            needsSave = true;

        } else if (timeUntilLive <= -55000 && r.status !== 'FINISHED') {
            r.status = 'FINISHED';
            r.liveMin = "FT";
            r.matches.forEach(m => {
                m.hs = m.events.filter(e => e.type === 'home').length;
                m.as = m.events.filter(e => e.type === 'away').length;
            });
            
            await processVirtualRoundSettlement(r);
            updateVirtualStandings(r);
            needsSave = true;
            
            if (r.matchday === 38) seasonEnded = true;
        }
    }

    if (needsSave) await VirtualState.updateOne({ seasonId: vState.seasonId }, vState);
    if (seasonEnded) await startNewVirtualSeason(vState.currentSeason + 1);
}

function updateVirtualStandings(r) {
    r.matches.forEach(m => {
        vState.resultsData.unshift({ md: r.matchday, match: `${m.home.short} - ${m.away.short}`, score: `${m.hs} : ${m.as}` });
        let hTeam = vState.standingsData.find(t => t.name === m.home.name);
        let aTeam = vState.standingsData.find(t => t.name === m.away.name);
        hTeam.p++; aTeam.p++;
        hTeam.gd += (m.hs - m.as); aTeam.gd += (m.as - m.hs);
        if(m.hs > m.as) hTeam.pts += 3;
        else if (m.hs < m.as) aTeam.pts += 3;
        else { hTeam.pts += 1; aTeam.pts += 1; }
    });
}

async function processVirtualRoundSettlement(r) {
    try {
        const pendingBets = await Bet.find({ status: 'Open', type: 'Virtuals' });
        
        for (let bet of pendingBets) {
            let sel = bet.selections[0]; 
            
            let m = r.matches.find(mx => mx.id === sel.matchId);
            
            if (m) {
                let isWin = false;
                let total = m.hs + m.as;
                let gg = m.hs > 0 && m.as > 0;
                
                if(sel.market === '1X2') {
                    if(sel.pick === '1' && m.hs > m.as) isWin = true;
                    if(sel.pick === 'X' && m.hs === m.as) isWin = true;
                    if(sel.pick === '2' && m.hs < m.as) isWin = true;
                } else if (sel.market === 'O/U 2.5') {
                    if(sel.pick === 'Over' && total > 2.5) isWin = true;
                    if(sel.pick === 'Under' && total < 2.5) isWin = true;
                } else if (sel.market === 'GG/NG') {
                    if(sel.pick === 'GG' && gg) isWin = true;
                    if(sel.pick === 'NG' && !gg) isWin = true;
                } else if (sel.market === 'Double Chance') {
                    if(sel.pick === '1X' && m.hs >= m.as) isWin = true;
                    if(sel.pick === '12' && m.hs !== m.as) isWin = true;
                    if(sel.pick === 'X2' && m.hs <= m.as) isWin = true;
                }
                
                bet.status = isWin ? 'Won' : 'Lost';
                await bet.save(); 
                
                if(isWin) {
                    const user = await User.findOne({ phone: bet.userPhone });
                    if(user) {
                        user.balance += bet.potentialWin;
                        await user.save();
                        await Transaction.create({ refId: `V-WIN-${bet.ticketId}`, userPhone: user.phone, type: 'win', method: 'Virtual Winnings', amount: bet.potentialWin });
                        sendPushNotification(user.phone, "Virtual Bet Won! 🥳", `Ticket ${bet.ticketId} won KES ${bet.potentialWin}!`, "win");
                    }
                } else {
                    sendPushNotification(bet.userPhone, "Virtual Bet Lost 😔", `Ticket ${bet.ticketId} lost. Better luck next time!`, "bet");
                }
            }
        }
    } catch(e) { console.error("Virtuals Settlement Error", e); }
}

app.get('/api/virtuals/state', async (req, res) => {
    res.json({ success: true, state: vState });
});


// ==========================================
// AVIATOR ENGINE (UNTOUCHED)
// ==========================================
let aviatorState = {
    status: 'WAITING',
    startTime: 0,
    crashPoint: 1.00,
    history: [1.24, 3.87, 11.20, 1.01, 6.42]
};

function runAviatorLoop() {
    if (aviatorState.status === 'WAITING') {
        setTimeout(() => {
            aviatorState.status = 'FLYING';
            aviatorState.startTime = Date.now();
            
            aviatorState.crashPoint = Math.random() < 0.4 ? (1.00 + Math.random() * 0.5) : (1.5 + Math.random() * 10);
            const flightDuration = (Math.log(aviatorState.crashPoint) / 0.06) * 1000;
            
            setTimeout(() => {
                aviatorState.status = 'CRASHED';
                aviatorState.history.unshift(aviatorState.crashPoint);
                if(aviatorState.history.length > 20) aviatorState.history.pop();
                
                Bet.updateMany({ type: 'Aviator', status: 'Open' }, { $set: { status: 'Lost' } }).catch(e=>{});
                
                setTimeout(() => {
                    aviatorState.status = 'WAITING';
                    runAviatorLoop(); 
                }, 4000);
                
            }, flightDuration);

        }, 5000);
    }
}
runAviatorLoop();

app.get('/api/aviator/state', (req, res) => {
    res.json({
        success: true,
        status: aviatorState.status,
        startTime: aviatorState.startTime,
        crashPoint: aviatorState.status === 'CRASHED' ? aviatorState.crashPoint : null,
        history: aviatorState.history
    });
});

app.post('/api/aviator/bet', async (req, res) => {
    try {
        const { userPhone, amount } = req.body;
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false });

        const betAmt = Number(amount);

        if (betAmt < 0) {
            user.balance += Math.abs(betAmt);
            await user.save();
            await Transaction.create({ refId: `AV-REF-${Date.now()}`, userPhone, type: 'refund', method: 'Aviator Refund', amount: Math.abs(betAmt) });
            await Bet.findOneAndDelete({ userPhone: userPhone, type: 'Aviator', status: 'Open' });
            return res.json({ success: true, newBalance: user.balance });
        }

        if (user.balance >= betAmt) {
            user.balance -= betAmt;
            await user.save();
            const tId = `AV-BET-${Date.now()}`;
            
            await Transaction.create({ refId: tId, userPhone, type: 'bet', method: 'Aviator Bet', amount: -betAmt });
            await Bet.create({ ticketId: tId, userPhone: user.phone, stake: betAmt, potentialWin: 0, type: 'Aviator', status: 'Open', selections: [{ match: "Aviator Round", market: "Crash", pick: "Auto", odds: 1.0 }] });

            res.json({ success: true, newBalance: user.balance });
        } else {
            res.status(400).json({ success: false });
        }
    } catch(e) { res.status(500).json({ success: false }); }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 ApexBet Server live on port ${PORT}`);
});