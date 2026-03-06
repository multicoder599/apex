require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
const bcrypt = require('bcryptjs'); // NEW: Added for secure password hashing

const app = express();

// ==========================================
// CORS CONFIGURATION
// ==========================================
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    /https:\/\/.*\.surge\.sh$/ // Securely allows any surge.sh subdomain
];

// In development, sometimes it's easier to just allow all origins. 
// If you face CORS issues testing locally, you can temporarily change this to cors()
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
    password: { type: String, required: true }, 
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

// --- 3. Transaction Model ---
const transactionSchema = new mongoose.Schema({
    refId: { type: String, required: true, unique: true },
    userPhone: { type: String, required: true },
    type: { type: String, enum: ['deposit', 'withdraw', 'bet', 'bonus', 'win'], required: true },
    method: { type: String, required: true },
    amount: { type: Number, required: true }, 
    status: { type: String, enum: ['Pending', 'Success', 'Failed'], default: 'Success' },
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', transactionSchema);


// ==========================================
// SECURE ODDS API PROXY
// ==========================================
const ODDS_API_KEY = process.env.ODDS_API_KEY;

app.get('/api/sports', async (req, res) => {
    try {
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/?apiKey=${ODDS_API_KEY}`);
        res.json(response.data);
    } catch (error) {
        console.error('Odds API Sports Error:', error.message);
        res.status(500).json({ error: 'Failed to fetch sports' });
    }
});

app.get('/api/odds/:sportKey', async (req, res) => {
    try {
        const { sportKey } = req.params;
        const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sportKey}/odds/`, {
            params: {
                apiKey: ODDS_API_KEY,
                regions: 'eu,uk,us',
                markets: 'h2h,totals,btts',
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
// UPGRADED AUTHENTICATION ENDPOINTS
// ==========================================

// REGISTER
app.post('/api/register', async (req, res) => {
    try {
        const { phone, password, name } = req.body;
        
        // 1. Basic validation
        if (!phone || !password) {
            return res.status(400).json({ success: false, message: 'Phone and password are required.' });
        }

        // 2. Check if user already exists
        const existingUser = await User.findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Phone number already registered. Please login.' });
        }

        // 3. Hash the password securely
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        // 4. Create new user with hashed password
        const newUser = new User({ 
            phone, 
            password: hashedPassword, 
            name: name || 'New Player', 
            balance: 100 // 100 KES Welcome Bonus
        });
        await newUser.save();

        // 5. Log the welcome bonus as a transaction
        await Transaction.create({
            refId: 'BONUS-' + Math.floor(Math.random() * 900000),
            userPhone: phone,
            type: 'bonus',
            method: 'Welcome Bonus',
            amount: 100
        });

        // 6. Return success (DO NOT send the password back to the client)
        res.json({ success: true, user: { name: newUser.name, balance: newUser.balance, phone: newUser.phone } });
    } catch (error) {
        console.error("Registration Error: ", error);
        // This will send the EXACT MongoDB/Server error to your frontend popup!
        res.status(500).json({ success: false, message: 'Server crash details: ' + error.message });
    }
});

// LOGIN
app.post('/api/login', async (req, res) => {
    try {
        const { phone, password } = req.body;

        // 1. Find user by phone number
        const user = await User.findOne({ phone });
        if (!user) {
            return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
        }

        // 2. Compare the provided password with the hashed password in the DB
        const isMatch = await bcrypt.compare(password, user.password);
        
        // 3. Handle older un-hashed passwords (useful if you registered users before adding bcrypt)
        // If bcrypt fails, check if it matches the plain text. If it does, hash it and save it for future use.
        if (!isMatch) {
            if (password === user.password) {
                const salt = await bcrypt.genSalt(10);
                user.password = await bcrypt.hash(password, salt);
                await user.save();
            } else {
                return res.status(401).json({ success: false, message: 'Invalid phone number or password' });
            }
        }

        // 4. Successful login
        res.json({ success: true, user: { name: user.name, balance: user.balance, phone: user.phone } });
        
    } catch (error) {
        console.error("Login Error: ", error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


// ==========================================
// FINANCE ENDPOINTS
// ==========================================
app.post('/api/deposit', async (req, res) => {
    try {
        const { userPhone, amount, method } = req.body;
        
        const user = await User.findOne({ phone: userPhone });
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        user.balance += Number(amount);
        await user.save();

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

        user.balance -= Number(amount);
        await user.save();

        const refId = 'WD-' + Math.floor(100000 + Math.random() * 900000);
        await Transaction.create({ refId, userPhone, type: 'withdraw', method, amount: -Number(amount) });

        res.json({ success: true, newBalance: user.balance, refId });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Withdrawal processing failed' });
    }
});

app.get('/api/transactions/:phone', async (req, res) => {
    try {
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

        user.balance -= stake;
        await user.save();

        const ticketId = 'TXN-' + Math.floor(Math.random() * 900000 + 100000);
        
        const newBet = new Bet({ 
            ticketId, userPhone, stake, potentialWin, selections, type: betType || 'Sports' 
        });
        await newBet.save();

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