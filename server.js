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
      initVirtualsEngine(); 
  })
  .catch(err => console.error('❌ MongoDB connection error:', err));

const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, 
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    bonusBalance: { type: Number, default: 0 },
    referredBy: { type: String, default: null }, 
    notifications: { type: Array, default: [] }, 
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

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

const virtualStateSchema = new mongoose.Schema({
    seasonId: { type: String, required: true, unique: true },
    currentSeason: Number,
    rounds: Array,
    standingsData: Array,
    resultsData: Array,
    updatedAt: { type: Date, default: Date.now }
});
const VirtualState = mongoose.model('VirtualState', virtualStateSchema);

const fixedGameSchema = new mongoose.Schema({
    matchName: { type: String, required: true },
    result_1x2: { type: String }, 
    result_ou25: { type: String }, 
    result_ggng: { type: String }, 
    ft_score: { type: String }, 
    createdAt: { type: Date, default: Date.now }
});
const FixedGame = mongoose.model('FixedGame', fixedGameSchema);

const bookingSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true },
    selections: { type: Array, required: true },
    createdAt: { type: Date, default: Date.now, expires: 172800 } 
});
const Booking = mongoose.model('Booking', bookingSchema);

// 🟢 ADMIN CONTROL SETTINGS SCHEMA
const configSchema = new mongoose.Schema({
    settingId: { type: String, default: 'global', unique: true },
    aviatorWinChance: { type: Number, default: 30 },
    virtualsMargin: { type: Number, default: 1.20 }
});
const SystemConfig = mongoose.model('SystemConfig', configSchema);

// Load Settings into Memory for fast access
let globalSettings = { aviatorWinChance: 30, virtualsMargin: 1.20 };
SystemConfig.findOne({ settingId: 'global' }).then(conf => {
    if (conf) { 
        globalSettings.aviatorWinChance = conf.aviatorWinChance; 
        globalSettings.virtualsMargin = conf.virtualsMargin; 
    } else { 
        SystemConfig.create({ settingId: 'global', aviatorWinChance: 30, virtualsMargin: 1.20 }); 
    }
});


// ==========================================
// NOTIFICATIONS
// ==========================================
app.get('/api/notifications/:phone', async (req, res) => {
    try {
        let rawPhone = req.params.phone.replace(/\D/g, '');
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
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
            title: title, message: message, type: type, isRead: false, createdAt: new Date()
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

        let rawPhone = userPhone.replace(/\D/g, ''); 
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        let formattedPhone = phone254;

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
        if (!user) return;

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
    } catch (err) {}
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        
        let rawPhone = userPhone.replace(/\D/g, '');
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        
        if (user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient withdrawable funds.' });

        user.balance -= Number(amount);
        await user.save();

        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone: user.phone, type: 'withdraw', method, amount: -Number(amount), status: 'Success' });

        sendPushNotification(user.phone, "Withdrawal Sent", `KES ${amount} has been sent to your M-Pesa.`, "withdraw");
        sendTelegramMessage(`💸 <b>WITHDRAWAL REQUEST</b> 💸\n\n👤 <b>User:</b> ${user.phone}\n💰 <b>Amount:</b> KES ${amount}\n🧾 <b>Ref:</b> ${refId}`);

        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) { res.status(500).json({ success: false, message: 'Withdrawal processing failed' }); }
});

app.get('/api/balance/:phone', async (req, res) => {
    try {
        let rawPhone = req.params.phone.replace(/\D/g, '');
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });
        
        res.json({ success: true, balance: user.balance, bonusBalance: user.bonusBalance || 0 });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error fetching balance' }); }
});

app.get('/api/transactions/:phone', async (req, res) => {
    try {
        let rawPhone = req.params.phone.replace(/\D/g, '');
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const txns = await Transaction.find({ userPhone: user.phone }).sort({ createdAt: -1 });
        res.json({ success: true, transactions: txns });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to fetch transactions' }); }
});

app.get('/api/test', (req, res) => {
    res.json({ success: true, message: "Server is awake!" });
});


// ==========================================
// BOOKING CODE ENDPOINTS
// ==========================================
app.post('/api/book-bet', async (req, res) => {
    try {
        const { selections } = req.body;
        if (!selections || !Array.isArray(selections) || selections.length === 0) {
            return res.status(400).json({ success: false, message: 'Betslip is empty.' });
        }
        const code = Math.random().toString(36).substring(2, 8).toUpperCase();
        await Booking.create({ code, selections });
        res.json({ success: true, code: code });
    } catch (error) {
        console.error("Booking Error:", error);
        res.status(500).json({ success: false, message: 'Failed to generate booking code.' });
    }
});

app.get('/api/book-bet/:code', async (req, res) => {
    try {
        const code = req.params.code.trim().toUpperCase();
        const booking = await Booking.findOne({ code });
        if (!booking) return res.status(404).json({ success: false, message: 'Invalid or expired booking code.' });
        res.json({ success: true, selections: booking.selections });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to load booking code.' }); }
});


// ==========================================
// SPORTS BETTING ENDPOINTS (Added Outcome init)
// ==========================================
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin, betType } = req.body;
        
        if (!userPhone) return res.status(400).json({ success: false, message: 'Missing user phone number.' });
        if (!selections || !Array.isArray(selections) || selections.length === 0) {
            return res.status(400).json({ success: false, message: 'Your betslip is empty.' });
        }
        
        const numStake = Number(stake);
        if (isNaN(numStake) || numStake < 10) {
            return res.status(400).json({ success: false, message: 'Invalid stake. Minimum is KES 10.' });
        }

        let rawPhone = String(userPhone).replace(/\D/g, '');
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
        
        if (!user) {
            return res.status(404).json({ success: false, message: 'Account session error. Please log out and log in again.' });
        }

        const totalAvailable = (user.balance || 0) + (user.bonusBalance || 0);

        if (totalAvailable < numStake) {
            return res.status(400).json({ success: false, message: 'Insufficient balance to place this bet.' });
        }

        // Deduct from balances
        let remainingStake = numStake;
        if (user.bonusBalance >= remainingStake) {
            user.bonusBalance -= remainingStake; 
            remainingStake = 0;
        } else {
            remainingStake -= (user.bonusBalance || 0); 
            user.bonusBalance = 0;
            user.balance -= remainingStake; 
        }
        await user.save();

        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        
        const mappedSelections = selections.map(s => ({
            match: s.match || s.matchName || 'Unknown Match',
            market: s.market || '-',
            pick: s.pick || '-',
            odds: Number(s.odds) || 1.00,
            status: 'Pending',
            outcome: 'Pending', // <-- ADDED for Detail View mapping
            startTime: s.startTime || Date.now(),
            matchId: s.matchId || null 
        }));

        const newBet = new Bet({ 
            ticketId: ticketId, 
            userPhone: user.phone, 
            stake: numStake, 
            potentialWin: Number(potentialWin) || 0, 
            selections: mappedSelections, 
            type: betType || 'Sports' 
        });
        await newBet.save();

        await Transaction.create({ 
            refId: ticketId, 
            userPhone: user.phone, 
            type: 'bet', 
            method: `${betType || 'Sports'} Bet`, 
            amount: -numStake 
        });

        const safeType = betType ? betType.toUpperCase() : 'SPORTS';
        const telegramMsg = `🚨 <b>NEW ${safeType} BET</b> 🚨\n\n` +
                            `👤 <b>User:</b> ${user.phone}\n` +
                            `💵 <b>Stake:</b> KES ${numStake}\n` +
                            `🏆 <b>Potential Win:</b> KES ${Number(potentialWin).toFixed(2)}\n` +
                            `🔢 <b>Selections:</b> ${mappedSelections.length}\n` +
                            `🧾 <b>Ticket ID:</b> ${ticketId}`;
        sendTelegramMessage(telegramMsg);

        res.json({ success: true, newBalance: user.balance, newBonus: user.bonusBalance, ticketId: newBet.ticketId });
    } catch (error) { 
        console.error("Place Bet Error: ", error);
        res.status(500).json({ success: false, message: 'Server Error: ' + error.message }); 
    }
});

app.get('/api/bets/:phone', async (req, res) => {
    try {
        let rawPhone = req.params.phone.replace(/\D/g, '');
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const bets = await Bet.find({ userPhone: user.phone }).sort({ createdAt: -1 });
        res.json({ success: true, bets });
    } catch (error) { res.status(500).json({ success: false, message: 'Failed to fetch betting history' }); }
});

app.post('/api/cashout', async (req, res) => {
    try {
        const { ticketId, userPhone, amount } = req.body;
        
        let rawPhone = userPhone.replace(/\D/g, '');
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        if (ticketId && ticketId.startsWith('AV-')) {
            user.balance += amount;
            await user.save();
            await Bet.updateOne({ ticketId: ticketId }, { $set: { status: 'Cashed Out' } });
            await Transaction.create({ refId: ticketId + '-WIN', userPhone: user.phone, type: 'win', method: 'Aviator Win', amount: amount });
            sendPushNotification(user.phone, "Aviator Cashout! ✈️", `You successfully cashed out KES ${amount.toFixed(2)}.`, "cashout");
            return res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
        }

        const bet = await Bet.findOne({ ticketId: ticketId, userPhone: user.phone });
        if (!bet) return res.status(404).json({ success: false, message: 'Ticket not found.' });
        if (bet.status !== 'Open') return res.status(400).json({ success: false, message: 'Ticket is already settled.' });

        bet.status = 'Cashed Out';
        await bet.save();

        user.balance += amount;
        await user.save();

        await Transaction.create({ refId: `CO-${ticketId}`, userPhone: user.phone, type: 'cashout', method: 'Cashout', amount: amount });

        sendPushNotification(user.phone, "Bet Cashed Out", `You successfully cashed out KES ${amount}.`, "cashout");
        res.json({ success: true, message: 'Cashout successful', newBalance: user.balance });
    } catch (error) { res.status(500).json({ success: false, message: 'Server error processing cashout' }); }
});


// ==========================================
// 🟢 FIXED: REALISTIC BACKGROUND BET SETTLEMENT (Applies correct Outcome)
// ==========================================
setInterval(async () => {
    try {
        const openBets = await Bet.find({ status: 'Open', type: { $nin: ['Aviator', 'Virtuals'] } });
        const fixedGames = await FixedGame.find({});
        const now = Date.now();

        for (let bet of openBets) {
            let allFinished = true;
            let hasLost = false;
            let hasPending = false;

            let updatedSelections = [...bet.selections];

            for (let i = 0; i < updatedSelections.length; i++) {
                let sel = updatedSelections[i];

                if (sel.status === 'Won') continue; 
                if (sel.status === 'Lost') { hasLost = true; break; }

                let startTime = Number(sel.startTime);
                if (!startTime || isNaN(startTime)) {
                     startTime = new Date(bet.createdAt).getTime();
                }
                
                // Exactly 2 Hours after the guaranteed correct startTime
                let endTime = startTime + (120 * 60 * 1000); 

                if (now < endTime) {
                    allFinished = false;
                    hasPending = true;
                    continue; 
                }

                let isWin = false;
                let fixedMatch = fixedGames.find(fg => fg.matchName === sel.match);

                if (fixedMatch) {
                    sel.finalScore = fixedMatch.ft_score || "Settled"; 
                    sel.ftScore = sel.finalScore; // Pass to detail view

                    // Validate against actual result and save the outcome
                    if (sel.market === '1X2' || sel.market === 'Match Winner') {
                        isWin = (sel.pick === fixedMatch.result_1x2);
                        sel.outcome = fixedMatch.result_1x2;
                    } else if (sel.market === 'O/U 2.5') {
                        isWin = (sel.pick === fixedMatch.result_ou25);
                        sel.outcome = fixedMatch.result_ou25;
                    } else if (sel.market === 'GG/NG') {
                        isWin = (sel.pick === fixedMatch.result_ggng);
                        sel.outcome = fixedMatch.result_ggng;
                    } else if (sel.market === 'Correct Score') {
                        isWin = (sel.pick === fixedMatch.ft_score);
                        sel.outcome = fixedMatch.ft_score;
                    } else {
                        isWin = (sel.pick === fixedMatch.result_1x2);
                        sel.outcome = fixedMatch.result_1x2;
                    }
                } else {
                    // Random settlement logic
                    sel.finalScore = "Settled"; 
                    sel.ftScore = sel.finalScore;
                    
                    if (sel.market === 'Correct Score') {
                        isWin = Math.random() < 0.05; 
                        sel.outcome = isWin ? sel.pick : "Other";
                    } else {
                        isWin = Math.random() < 0.40;
                        sel.outcome = isWin ? sel.pick : "Other";
                    }
                }

                sel.status = isWin ? 'Won' : 'Lost';

                if (!isWin) {
                    hasLost = true;
                    break; 
                }
            }

            bet.selections = updatedSelections;
            bet.markModified('selections'); // Critical for saving sub-document updates

            if (hasLost) {
                bet.status = 'Lost';
                await bet.save();
                sendPushNotification(bet.userPhone, "Bet Lost 😔", `Ticket ${bet.ticketId} lost. Better luck next time!`, "bet");
            } else if (allFinished && !hasPending) {
                bet.status = 'Won';
                await bet.save();
                
                const user = await User.findOne({ phone: bet.userPhone });
                if (user) {
                    user.balance += bet.potentialWin;
                    await user.save();
                    
                    await Transaction.create({ 
                        refId: `WIN-${bet.ticketId}`, userPhone: user.phone, 
                        type: 'win', method: 'Bet Winnings', amount: bet.potentialWin 
                    });
                    
                    sendPushNotification(user.phone, "Bet Won! 🥳", `Ticket ${bet.ticketId} won! KES ${bet.potentialWin} added to your balance.`, "win");
                }
            }
        }
    } catch (error) { 
        console.error("Realistic Settlement Error:", error.message); 
    }
}, 60 * 1000);


// ==========================================
// ADMIN ROUTES & GAME CONTROLS
// ==========================================
app.get('/api/admin/config', async (req, res) => {
    res.json({ success: true, config: globalSettings });
});

app.post('/api/admin/config', async (req, res) => {
    try {
        const { aviatorWinChance, virtualsMargin } = req.body;
        globalSettings.aviatorWinChance = Number(aviatorWinChance) || 30;
        globalSettings.virtualsMargin = Number(virtualsMargin) || 1.20;
        
        await SystemConfig.updateOne({ settingId: 'global' }, { $set: globalSettings }, { upsert: true });
        res.json({ success: true, message: 'Settings updated successfully', config: globalSettings });
    } catch(e) { res.status(500).json({ success: false }); }
});

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

// ==========================================
// MANUAL FORCE SETTLEMENT OVERRIDE
// ==========================================
app.post('/api/admin/force-settle', async (req, res) => {
    try {
        const openBets = await Bet.find({ status: 'Open', type: { $nin: ['Aviator', 'Virtuals'] } });
        const fixedGames = await FixedGame.find({});
        let processedCount = 0;

        for (let bet of openBets) {
            let hasLost = false;
            let allFinished = true;
            let betModified = false;
            let updatedSelections = [...bet.selections];

            for (let i = 0; i < updatedSelections.length; i++) {
                let sel = updatedSelections[i];

                if (sel.status === 'Won') continue;
                if (sel.status === 'Lost') { hasLost = true; break; }

                let fixedMatch = fixedGames.find(fg => fg.matchName === sel.match);

                // ONLY settle if a fixed match exists. We ignore the 2-hour time rule here.
                if (fixedMatch) {
                    betModified = true;
                    let isWin = false;

                    sel.finalScore = fixedMatch.ft_score || "Settled";
                    sel.ftScore = sel.finalScore;

                    if (sel.market === '1X2' || sel.market === 'Match Winner') {
                        isWin = (sel.pick === fixedMatch.result_1x2);
                        sel.outcome = fixedMatch.result_1x2;
                    } else if (sel.market === 'O/U 2.5') {
                        isWin = (sel.pick === fixedMatch.result_ou25);
                        sel.outcome = fixedMatch.result_ou25;
                    } else if (sel.market === 'GG/NG') {
                        isWin = (sel.pick === fixedMatch.result_ggng);
                        sel.outcome = fixedMatch.result_ggng;
                    } else if (sel.market === 'Correct Score') {
                        isWin = (sel.pick === fixedMatch.ft_score);
                        sel.outcome = fixedMatch.ft_score;
                    } else {
                        isWin = (sel.pick === fixedMatch.result_1x2);
                        sel.outcome = fixedMatch.result_1x2;
                    }

                    sel.status = isWin ? 'Won' : 'Lost';
                    if (!isWin) hasLost = true;
                } else {
                    // If no fixed match is injected for this selection, it remains pending
                    allFinished = false; 
                }
            }

            if (betModified) {
                bet.selections = updatedSelections;
                bet.markModified('selections');

                if (hasLost) {
                    bet.status = 'Lost';
                    await bet.save();
                    processedCount++;
                    sendPushNotification(bet.userPhone, "Bet Lost 😔", `Ticket ${bet.ticketId} lost. Better luck next time!`, "bet");
                } else if (allFinished) {
                    bet.status = 'Won';
                    await bet.save();
                    processedCount++;
                    
                    const user = await User.findOne({ phone: bet.userPhone });
                    if (user) {
                        user.balance += bet.potentialWin;
                        await user.save();
                        await Transaction.create({ 
                            refId: `WIN-${bet.ticketId}`, userPhone: user.phone, 
                            type: 'win', method: 'Bet Winnings', amount: bet.potentialWin 
                        });
                        sendPushNotification(user.phone, "Bet Won! 🥳", `Ticket ${bet.ticketId} won! KES ${bet.potentialWin} added to your balance.`, "win");
                    }
                }
            }
        }
        res.json({ success: true, processed: processedCount });
    } catch(e) {
        res.status(500).json({ success: false, message: e.message });
    }
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
// UNIFIED GAMES ENDPOINT (Strict Timezone Parsing)
// ==========================================
let cachedApiGames = [];
let lastApiFetchTime = 0;
const API_CACHE_DURATION = 5 * 60 * 1000;

app.get('/api/games', async (req, res) => {
    try {
        const dbGamesRaw = await LiveGame.find({});
        
        let allGames = dbGamesRaw.map(g => {
            let match = g.toObject();
            if (!match.commence_time && match.time) {
                try {
                    let timeStr = match.time;
                    if (timeStr.includes(':')) {
                        let timeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
                        if (timeMatch) {
                            let d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
                            
                            if (timeStr.toLowerCase().includes('tomorrow')) {
                                d.setDate(d.getDate() + 1);
                            }
                            
                            let year = d.getFullYear();
                            let month = String(d.getMonth() + 1).padStart(2, '0');
                            let date = String(d.getDate()).padStart(2, '0');
                            let hrs = String(timeMatch[1]).padStart(2, '0');
                            let mins = String(timeMatch[2]).padStart(2, '0');
                            
                            // Explicitly force EAT (+03:00) so server UTC doesn't skew it
                            let exactEpoch = new Date(`${year}-${month}-${date}T${hrs}:${mins}:00+03:00`).getTime();
                            match.commence_time = exactEpoch;
                        }
                    }
                } catch(e) {}
            }
            if (!match.commence_time) match.commence_time = Date.now();
            return match;
        });

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
        
        const margin = globalSettings.virtualsMargin || 1.20; 
        
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

// 🟢 FIXED: VIRTUAL SETTLEMENT (Applies correct Outcome logic)
async function processVirtualRoundSettlement(r) {
    try {
        const pendingBets = await Bet.find({ status: 'Open', type: 'Virtuals' });
        const now = Date.now();
        
        for (let bet of pendingBets) {
            let updatedSelections = [...bet.selections];
            let hasLost = false;
            let allFinished = true; // Assume true unless proven otherwise

            for (let i = 0; i < updatedSelections.length; i++) {
                let sel = updatedSelections[i]; 
                
                let m = r.matches.find(mx => mx.id === sel.matchId || `${mx.home.name} vs ${mx.away.name}` === sel.match);
                
                if (m) {
                    let isWin = false;
                    let total = m.hs + m.as;
                    let gg = m.hs > 0 && m.as > 0;
                    let lowerMarket = sel.market.toLowerCase();
                    let actualOutcome = "-";

                    sel.ftScore = `${m.hs}:${m.as}`;

                    if(lowerMarket.includes('1x2') || lowerMarket === 'match winner') {
                        actualOutcome = m.hs > m.as ? '1' : (m.hs === m.as ? 'X' : '2');
                        if(sel.pick === '1' && m.hs > m.as) isWin = true;
                        if(sel.pick === 'X' && m.hs === m.as) isWin = true;
                        if(sel.pick === '2' && m.hs < m.as) isWin = true;
                    } else if (lowerMarket.includes('o/u') || lowerMarket.includes('over/under') || lowerMarket.includes('total goals')) {
                        actualOutcome = total > 2.5 ? 'Over 2.5' : 'Under 2.5';
                        if(sel.pick.includes('Over') && total > 2.5) isWin = true;
                        if(sel.pick.includes('Under') && total < 2.5) isWin = true;
                    } else if (lowerMarket.includes('gg') || lowerMarket.includes('both teams to score')) {
                        actualOutcome = gg ? 'GG' : 'NG';
                        if((sel.pick === 'GG' || sel.pick === 'Yes') && gg) isWin = true;
                        if((sel.pick === 'NG' || sel.pick === 'No') && !gg) isWin = true;
                    } else if (lowerMarket.includes('double chance')) {
                        actualOutcome = m.hs > m.as ? '1X/12' : (m.hs === m.as ? '1X/X2' : 'X2/12');
                        if(sel.pick === '1X' && m.hs >= m.as) isWin = true;
                        if(sel.pick === '12' && m.hs !== m.as) isWin = true;
                        if(sel.pick === 'X2' && m.hs <= m.as) isWin = true;
                    }
                    
                    sel.outcome = actualOutcome;
                    sel.status = isWin ? 'Won' : 'Lost';

                    if (!isWin) hasLost = true;

                } else {
                    // Match wasn't found in this round, check if it timed out globally
                    if (now - new Date(bet.createdAt).getTime() > 5 * 60 * 1000) {
                        sel.status = 'Cashed Out'; // Timeout essentially refunds the bet
                    } else {
                        allFinished = false; // Still waiting for a different round
                    }
                }
            }

            bet.selections = updatedSelections;
            bet.markModified('selections');

            let rawPhone = bet.userPhone.replace(/\D/g, '');
            let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
            let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

            const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });

            if (hasLost) {
                bet.status = 'Lost';
                await bet.save(); 
                if(user) {
                    sendPushNotification(user.phone, "Virtual Bet Lost 😔", `Ticket ${bet.ticketId} lost. Better luck next time!`, "bet");
                }
            } else if (allFinished) {
                // Check if all legs are 'Cashed Out' (Timed out)
                if (updatedSelections.every(s => s.status === 'Cashed Out')) {
                    bet.status = 'Cashed Out';
                    await bet.save();
                    if(user) {
                        user.balance += bet.stake;
                        await user.save();
                        await Transaction.create({ refId: `REF-${bet.ticketId}`, userPhone: user.phone, type: 'refund', method: 'Virtuals Timeout Refund', amount: bet.stake });
                    }
                } else {
                    // It's a clean Win
                    bet.status = 'Won';
                    await bet.save(); 
                    if(user) {
                        user.balance += bet.potentialWin;
                        await user.save();
                        await Transaction.create({ refId: `V-WIN-${bet.ticketId}`, userPhone: user.phone, type: 'win', method: 'Virtual Winnings', amount: bet.potentialWin });
                        sendPushNotification(user.phone, "Virtual Bet Won! 🥳", `Ticket ${bet.ticketId} won KES ${bet.potentialWin}!`, "win");
                    }
                }
            }
        }
    } catch(e) { console.error("Virtuals Settlement Error", e); }
}

app.get('/api/virtuals/state', async (req, res) => {
    res.json({ success: true, state: vState });
});


// ==========================================
// AVIATOR ENGINE
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
            
            const winChanceDec = (globalSettings.aviatorWinChance || 30) / 100; 
            
            if (Math.random() > winChanceDec) {
                aviatorState.crashPoint = 1.00 + (Math.random() * 0.40);
            } else {
                aviatorState.crashPoint = 1.40 + (Math.random() * 8.60);
            }

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
        
        let rawPhone = userPhone.replace(/\D/g, '');
        let phone0 = rawPhone.startsWith('254') ? '0' + rawPhone.substring(3) : rawPhone;
        let phone254 = rawPhone.startsWith('0') ? '254' + rawPhone.substring(1) : rawPhone;

        const user = await User.findOne({ $or: [{ phone: rawPhone }, { phone: phone0 }, { phone: phone254 }] });
        if (!user) return res.status(404).json({ success: false });

        const betAmt = Number(amount);

        if (betAmt < 0) {
            user.balance += Math.abs(betAmt);
            await user.save();
            await Transaction.create({ refId: `AV-REF-${Date.now()}`, userPhone: user.phone, type: 'refund', method: 'Aviator Refund', amount: Math.abs(betAmt) });
            await Bet.findOneAndDelete({ userPhone: user.phone, type: 'Aviator', status: 'Open' });
            return res.json({ success: true, newBalance: user.balance });
        }

        if (user.balance >= betAmt) {
            user.balance -= betAmt;
            await user.save();
            const tId = `AV-BET-${Date.now()}`;
            
            await Transaction.create({ refId: tId, userPhone: user.phone, type: 'bet', method: 'Aviator Bet', amount: -betAmt });
            await Bet.create({ ticketId: tId, userPhone: user.phone, stake: betAmt, potentialWin: 0, type: 'Aviator', status: 'Open', selections: [{ match: "Aviator Round", market: "Crash", pick: "Auto", odds: 1.0 }] });

            const telegramMsg = `✈️ <b>NEW AVIATOR BET</b> ✈️\n\n` +
                                `👤 <b>User:</b> ${user.phone}\n` +
                                `💵 <b>Stake:</b> KES ${betAmt}\n` +
                                `🧾 <b>Ticket ID:</b> ${tId}`;
            sendTelegramMessage(telegramMsg);

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