import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import User from './models/User.js';
import Image from './models/Image.js';

dotenv.config();


const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected successfully'))
  .catch((err) => console.log('❌ MongoDB connection error:', err));

// =======================
// AUTHENTICATION ROUTES
// =======================

// 1. SIGNUP ROUTE
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user (credits will default to 10)
    const newUser = new User({
      name,
      email,
      password: hashedPassword
    });
    
    await newUser.save();

    res.status(201).json({ message: 'User created successfully', credits: newUser.credits });
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ error: 'Server error during signup' });
  }
});

// 2. LOGIN ROUTE
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find the user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Create JWT Token
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        credits: user.credits
      }
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: 'Server error during login' });
  }
});

// =======================
// USER PROFILE ROUTE
// =======================

// Middleware to verify token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied' });

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid token' });
  }
};

// Get current user details
app.get('/api/users/me', verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (error) {
    console.error("Profile Error:", error);
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

// =======================
// AI GENERATION ROUTE (Step 3 & 4)
// =======================

app.post('/api/generate', verifyToken, async (req, res) => {
  try {
    const { prompt, style = 'Photorealistic', aspectRatio = '1:1' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Check Credits (Step 4)
    const user = await User.findById(req.user.id);
    if (!user || user.credits <= 0) {
      return res.status(403).json({ error: 'Not enough credits! Please upgrade.' });
    }

    // Style Enhancements for Realism
    let styleModifiers = "";
    if (style === 'Photorealistic') {
      styleModifiers = ", extremely high quality, photorealistic, 8k resolution, raw photo, realistic, cinematic lighting, highly detailed masterpiece, ultra-realistic, sharp focus";
    } else if (style === 'Anime') {
      styleModifiers = ", anime style, studio ghibli, highly detailed, beautiful lighting, vibrant colors, 4k anime masterpiece";
    } else if (style === 'Digital Art') {
      styleModifiers = ", trending on artstation, digital art masterpiece, highly detailed, vibrant colors, fantasy concept art";
    } else if (style === 'Oil Painting') {
      styleModifiers = ", classic oil painting, fine brush strokes, highly detailed, masterpiece, beautiful lighting";
    }
    
    const finalPrompt = prompt + styleModifiers;

    // Aspect Ratio Handling
    let width = 1024;
    let height = 1024;
    if (aspectRatio === '16:9') {
      width = 1280;
      height = 720;
    } else if (aspectRatio === '9:16') {
      width = 720;
      height = 1280;
    }

    // Generate Image URL with better quality models
    const encodedPrompt = encodeURIComponent(finalPrompt);
    const randomSeed = Math.floor(Math.random() * 1000000);
    const pollUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?seed=${randomSeed}&width=${width}&height=${height}&nologo=true&model=flux&enhance=true`;

    // Fetch image from Pollinations in the backend to avoid frontend CORS/Adblock issues
    const imageResponse = await fetch(pollUrl);
    if (!imageResponse.ok) {
      throw new Error('Failed to fetch from AI provider');
    }
    const arrayBuffer = await imageResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Image = `data:image/jpeg;base64,${buffer.toString('base64')}`;

    // Save to Image History
    const newImage = new Image({
      userId: req.user.id,
      prompt,
      imageUrl: base64Image,
      shareUrl: pollUrl,
      style,
      aspectRatio
    });
    await newImage.save();

    // Deduct Credit
    user.credits -= 1;
    await user.save();

    res.json({
      imageUrl: base64Image,
      shareUrl: pollUrl,
      credits: user.credits,
      imageId: newImage._id
    });

  } catch (error) {
    console.error("Generation Error:", error);
    res.status(500).json({ error: 'Server error during image generation' });
  }
});

// =======================
// GALLERY ROUTE (Personal Gallery)
// =======================

app.get('/api/gallery', verifyToken, async (req, res) => {
  try {
    const images = await Image.find({ userId: req.user.id }).sort({ createdAt: -1 });
    res.json(images);
  } catch (error) {
    console.error("Gallery Error:", error);
    res.status(500).json({ error: 'Server error fetching gallery' });
  }
});

// =======================
// PUBLIC SHARE ROUTE (Showcase Page)
// =======================

app.get('/api/shared-image/:id', async (req, res) => {
  try {
    const image = await Image.findById(req.params.id).populate('userId', 'name');
    if (!image) return res.status(404).json({ error: 'Image not found' });
    
    res.json({
      prompt: image.prompt,
      imageUrl: image.shareUrl || image.imageUrl,
      style: image.style,
      aspectRatio: image.aspectRatio,
      authorName: image.userId?.name || 'AI Artist',
      createdAt: image.createdAt
    });
  } catch (error) {
    console.error("Shared Image Error:", error);
    res.status(500).json({ error: 'Server error fetching shared image' });
  }
});

// =======================
// RAZORPAY PAYMENT ROUTES (Step 5)
// =======================

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Credit Plans
const PLANS = {
  basic:   { credits: 50,  amountINR: 99,  label: "Basic"   },
  pro:     { credits: 200, amountINR: 299, label: "Pro"     },
  premium: { credits: 500, amountINR: 599, label: "Premium" },
};

// GET - Fetch available plans (public)
app.get('/api/payment/plans', (req, res) => {
  res.json(PLANS);
});

// POST - Create a Razorpay Order
app.post('/api/payment/create-order', verifyToken, async (req, res) => {
  try {
    const { planId } = req.body;
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: 'Invalid plan selected' });

    const options = {
      amount: plan.amountINR * 100, // Razorpay works in paise (1 INR = 100 paise)
      currency: 'INR',
      receipt: `receipt_${req.user.id}_${Date.now()}`,
      notes: {
        userId: req.user.id,
        planId: planId,
        credits: plan.credits,
      }
    };

    const order = await razorpay.orders.create(options);
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      plan,
    });
  } catch (error) {
    console.error('Create Order Error:', error);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// POST - Verify Payment & Add Credits
app.post('/api/payment/verify', verifyToken, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = req.body;

    // Verify signature (security check)
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed! Invalid signature.' });
    }

    // Signature valid → Add credits to user
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ error: 'Invalid plan' });

    const user = await User.findById(req.user.id);
    user.credits += plan.credits;
    await user.save();

    console.log(`✅ Payment verified. Added ${plan.credits} credits to user ${user.email}`);

    res.json({
      success: true,
      message: `${plan.credits} credits added successfully!`,
      credits: user.credits,
    });
  } catch (error) {
    console.error('Verify Payment Error:', error);
    res.status(500).json({ error: 'Server error during payment verification' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});
