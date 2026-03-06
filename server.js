require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');

const app = express();

// ==========================================
// CORS CONFIGURATION
// ==========================================
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    /https:\/\/.*\.surge\.sh$/ // Securely allows any surge.sh subdomain
];

app.use(cors({
    origin: function (origin, callback) {
        if (!origin || allowedOrigins.some(domain => 
            typeof domain === 'string' ? domain === origin : domain.test(origin)
        )) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// MONGODB CONNECTION & MODELS
// ==========================================
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully!'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// --- 1. User Model ---
const userSchema = new mongoose.Schema({
    phone: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // Remember to hash in production!
    name: { type: String, required: true },
    balance: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// --- 2. Bet Model ---
const betSchema = new mongoose.Schema({
    ticketId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    stake: { type: Number, required: true },
    potentialWin: { type: Number, required: true },
    selections: { type: Array, required: true },
    type: { type: String, enum: ['Sports', 'Jackpot', 'Aviator', 'Casino'], default: 'Sports' },
    status: { type: String, enum: ['Open', 'Won', 'Lost', 'Cashed Out'], default: 'Open' },
    createdAt: { type: Date, default: Date.now }
});
const Bet = mongoose.model('Bet', betSchema);

// --- 3. Transaction Model (NEW for Finance) ---
const transactionSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    type: { type: String, enum: ['deposit', 'withdraw', 'bet', 'bonus', 'win'], required: true },
    method: { type: String, required: true }, // e.g., 'M-Pesa', 'Card', 'Sports Bet'
    amount: { type: Number, required: true }, // Positive for deposits/wins, Negative for bets/withdrawals
    status: { type: String, enum: ['Pending', 'Success', 'Failed'], default: 'Success' },
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);


// ==========================================
// SECURE ODDS API PROXY (Hides your API Key)
// ==========================================
const ODDS_API_KEY = process.env.ODDS_API_KEY;

// Fetch active sports
app.get('/api/sports', async (req, res) => {
    try {
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
        res.json(response.data);
    } catch (error) {
        console.error('Odds API Sports Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch sports' });
    }
});

// Fetch odds for a specific sport (with multiple markets!)
app.get('/api/odds/:sportKey', async (req, res) => {
    try {
        const { sportKey } = req.params;
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
            params: {
                apiKey: ODDS_API_KEY,
                regions: 'eu,uk,us',
                markets: 'h2h,totals,btts', // Fetches 1X2, Over/Under, and BTTS
                oddsFormat: 'decimal'
            }
        });
        res.json(response.data);
    } catch (error) {
        console.error('Odds API Matches Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch odds' });
    }
});

// ==========================================
// AUTHENTICATION ENDPOINTS
// ==========================================
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const user = await User.findOne({ phone, password });
        if (user) {
            res.json({ success: true, user: { name: user.name, balance: user.balance, phone: user.phone } });
        } else {
            res.status(401).json({ success: false, message: 'Invalid phone number or password' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name } = req.body;
        
        const existingUser = await User.findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });
        }

        const newUser = new User({ phone, password, name: name || 'New Player', balance: 100 }); // 100 KES Welcome Bonus
        await newUser.save();

        // Log the welcome bonus as a transaction
        await Transaction.create({
            refId: 'BONUS-' + Math.floor(Math.random() * 900000),
            userPhone: phone,
            type: 'bonus',
            method: 'Welcome Bonus',
            amount: 100
        });

        res.json({ success: true, user: { name: newUser.name, balance: newUser.balance, phone: newUser.phone } });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'Server error during registration' });
    }
});

// ==========================================
// FINANCE ENDPOINTS (Deposits & Withdrawals)
// ==========================================
app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        // Update Balance
        user.balance += Number(amount);
        await user.save();

        // Create Transaction Record
        const refId = 'DEP-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone, type: 'deposit', method, amount: Number(amount) });

        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Deposit processing failed' });
    }
});

app.post('/api/withdraw', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        if (user.balance < amount) {
            return res.status(400).json({ success: false, message: 'Insufficient funds for withdrawal.' });
        }

        // Update Balance
        user.balance -= Number(amount);
        await user.save();

        // Create Transaction Record
        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone, type: 'withdraw', method, amount: -Number(amount) });

        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Withdrawal processing failed' });
    }
});

app.get('/api/transactions/:phone', async (req, res) => {
    try {
        // Fetch user's transactions, sorted by newest first
        const txns = await Transaction.find({ userPhone: req.params.phone }).sort({ createdAt: -1 });
        res.json({ success: true, transactions: txns });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
    }
});

// ==========================================
// BETTING ENDPOINT
// ==========================================
app.post('/api/place-bet', async (req, res) => {
    try {
        const { userPhone, stake, selections, potentialWin, betType } = req.body;
        const user = await User.findOne({ phone: userPhone });

        if (!user || user.balance < stake) {
            return res.status(400).json({ success: false, message: 'Insufficient funds! Please deposit.' });
        }

        // Deduct Stake
        user.balance -= stake;
        await user.save();

        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        
        // Save Bet
        const newBet = new Bet({ 
            ticketId, userPhone, stake, potentialWin, selections, type: betType || 'Sports' 
        });
        await newBet.save();

        // Log Bet as a Transaction in the user's history
        await Transaction.create({
            refId: ticketId,
            userPhone,
            type: 'bet',
            method: `${betType || 'Sports'} Bet`,
            amount: -stake
        });

        res.json({ success: true, newBalance: user.balance, ticketId: newBet.ticketId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Bet placement failed' });
    }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 ApexBet Server live on port ${PORT}`);
});