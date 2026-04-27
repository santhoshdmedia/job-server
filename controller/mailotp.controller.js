const {otpMail} = require("../mail/sendMail");
const {notifyMail}=require("../mail/sendMail")

// In-memory storage for OTPs (use Redis in production)
const otpStorage = new Map();

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// OTP Route Handler
const sendOtpHandler = async (req, res) => {
  try {
    const { email } = req.body;

    // Validation
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: "Email is required" 
      });
    }

    // Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid email format" 
      });
    }

    // Generate OTP
    const otp = generateOTP();
    
    // Store OTP with expiration (5 minutes)
    otpStorage.set(email, {
      otp,
      expiresAt: Date.now() + 300000 // 5 minutes
    });

    // Send OTP email
    const emailSent = await otpMail({ 
      email, 
      otp 
    });

    if (emailSent) {
      console.log(`OTP ${otp} sent to ${email}`);
      res.json({ 
        success: true, 
        message: "OTP sent successfully" 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: "Failed to send OTP email" 
      });
    }

  } catch (error) {
    console.error("Error in sendOtpHandler:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error" 
    });
  }
};

// Verify OTP Route Handler
const verifyOtpHandler = async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validation
    if (!email || !otp) {
      return res.status(400).json({ 
        success: false, 
        error: "Email and OTP are required" 
      });
    }

    // Check if OTP exists
    const storedData = otpStorage.get(email);
    if (!storedData) {
      return res.status(400).json({ 
        success: false, 
        error: "OTP not found or expired" 
      });
    }

    // Check expiration
    if (Date.now() > storedData.expiresAt) {
      otpStorage.delete(email); // Clean up expired OTP
      return res.status(400).json({ 
        success: false, 
        error: "OTP has expired" 
      });
    }

    // Verify OTP
    if (storedData.otp !== otp) {
      return res.status(400).json({ 
        success: false, 
        error: "Invalid OTP" 
      });
    }

    // OTP is valid - clean up and return success
    otpStorage.delete(email);
    
    res.json({ 
      success: true, 
      message: "OTP verified successfully" 
    });

  } catch (error) {
    console.error("Error in verifyOtpHandler:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error" 
    });
  }
};

// Optional: Resend OTP Handler
const resendOtpHandler = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        error: "Email is required" 
      });
    }

    // Remove any existing OTP for this email
    otpStorage.delete(email);

    // Generate new OTP
    const otp = generateOTP();
    
    // Store new OTP
    otpStorage.set(email, {
      otp,
      expiresAt: Date.now() + 300000 // 5 minutes
    });

    // Send new OTP email
    const emailSent = await otpMail({ 
      email, 
      otp 
    });

    if (emailSent) {
      console.log(`New OTP ${otp} sent to ${email}`);
      res.json({ 
        success: true, 
        message: "New OTP sent successfully" 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: "Failed to resend OTP" 
      });
    }

  } catch (error) {
    console.error("Error in resendOtpHandler:", error);
    res.status(500).json({ 
      success: false, 
      error: "Internal server error" 
    });
  }
};

const Notify=async (req, res) => {
  try {
    const { productName,email, productId, productUrl, userEmail, userPhone, userName } = req.body;
    
    // Send notification emails
    const mailSent = await notifyMail({
      productName,
      productId,
      productUrl,
      userEmail,
      userPhone,
      userName,
    });
    
    if (mailSent) {
      res.json({
        success: true,
        message: 'Notification request submitted successfully',
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send notification emails',
      });
    }
  } catch (error) {
    console.error('Error in notify-when-available:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
    });
  }
};


module.exports = {
  sendOtpHandler,
  verifyOtpHandler,
  resendOtpHandler,Notify
};