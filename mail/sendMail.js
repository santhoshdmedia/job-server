const nodemailer = require("nodemailer");
const { TemplateHelper } = require("./templateHelper");

// ─────────────────────────────────────────────
// Hostinger SMTP Transporter
// ─────────────────────────────────────────────

const webmailTransporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 587,
  secure: false,
  auth: {
    user: "info@printe.in",
    pass: "Printeinfo@2025",
  },
  tls: {
    rejectUnauthorized: false,
  },
  connectionTimeout: 10000,
  greetingTimeout:   10000,
});

webmailTransporter.verify(function (error) {
  if (error) {
    console.log("❌ Hostinger SMTP Connection failed:", error.message);
  } else {
    console.log("✅ Hostinger SMTP Server is ready to send emails");
  }
});

// ─────────────────────────────────────────────
// Generic send (uses TemplateHelper)
// Returns true | false — non-critical paths only
// ─────────────────────────────────────────────

const sendMail = async (values) => {
  try {
    await webmailTransporter.sendMail({
      from:    '"Printe" <info@printe.in>',
      to:      values.email,
      subject: TemplateHelper(values)?.subject,
      html:    TemplateHelper(values)?.templete,
    });
    console.log("✅ Email sent successfully via Hostinger");
    return true;
  } catch (err) {
    console.log("❌ Error sending email:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// BNI Welcome
// ─────────────────────────────────────────────

const BNIwelcome = async (values) => {
  try {
    await webmailTransporter.sendMail({
      from:    '"Printe" <info@printe.in>',
      to:      values.email,
      subject: TemplateHelper(values)?.subject,
      html:    TemplateHelper(values)?.templete,
    });
    console.log("✅ Email sent successfully via Hostinger");
    return true;
  } catch (err) {
    console.log("❌ Error sending email:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// OTP Mail
// ─────────────────────────────────────────────

const otpMail = async (values) => {
  try {
    await webmailTransporter.sendMail({
      from:    '"Printe" <info@printe.in>',
      to:      values.email,
      subject: "Your OTP Verification Code - Printe",
      html: `
        <div style="font-family:Arial,sans-serif;padding:20px;background-color:#f9f9f9;">
          <div style="max-width:600px;background:white;padding:30px;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,0.1);">

            <div style="text-align:center;margin-bottom:25px;">
              <img fetchpriority="high" loading="eager"
                   src="https://printe.in/assets/logo-BQbty1hL.png"
                   alt="Printe Logo"
                   style="max-height:70px;width:auto;display:block;margin:0 auto;" />
            </div>

            <h2 style="background:#f2c41a;color:black;padding:15px;border-radius:5px;text-align:center;font-size:22px;margin:0;">
              OTP Verification
            </h2>

            <div style="padding:20px 0;text-align:center;">
              <p style="font-size:16px;color:#333;margin-bottom:20px;">
                Hello,<br>
                Use the following OTP to complete your verification process:
              </p>
              <div style="background:#f8f9fa;padding:15px;border-radius:8px;border:2px dashed #f2c41a;display:inline-block;">
                <h1 style="color:#f2c41a;font-size:32px;letter-spacing:8px;margin:0;font-weight:bold;">
                  ${values.otp}
                </h1>
              </div>
              <p style="font-size:14px;color:#666;margin-top:20px;">
                This OTP is valid for <strong>5 minutes</strong>.<br>
                Do not share this code with anyone.
              </p>
            </div>

            <hr style="border:0;border-top:1px solid #ddd;margin:30px 0;">

            <div style="text-align:center;background:#060606;padding:10px;border-radius:8px;margin-top:5px;">
              <h3 style="color:#fff;margin-bottom:6px;font-size:16px;">Contact Information</h3>
              <div style="font-size:14px;color:#fff;">
                <p>
                  <strong>Email:</strong>
                  <a href="mailto:info@printe.in" style="color:#f2c41a;text-decoration:none;">info@printe.in</a>
                  &nbsp;&nbsp;
                  <strong>Website:</strong>
                  <a href="https://printe.in/" style="color:#f2c41a;text-decoration:none;">https://printe.in/</a>
                  &nbsp;&nbsp;
                  <strong>Phone:</strong> +91 95856 10000
                </p>
              </div>
            </div>

            <hr style="border:0;border-top:1px solid #ddd;margin:25px 0;">

            <div style="text-align:center;font-size:12px;color:#999;">
              <p style="margin:5px 0;">If you didn't request this OTP, please ignore this email.</p>
              <p style="margin:5px 0;">This is an automated message from Printe. Please do not reply to this email.</p>
              <p style="margin:10px 0;font-size:11px;color:#777;">© ${new Date().getFullYear()} Printe. All rights reserved.</p>
            </div>

          </div>
        </div>
      `,
    });
    console.log("✅ OTP email sent successfully to:", values.email);
    return true;
  } catch (err) {
    console.log("❌ Error sending OTP email:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// Inquiry Mail
// ─────────────────────────────────────────────

const inquiryMail = async (values) => {
  try {
    await webmailTransporter.sendMail({
      from:    '"Printe" <info@printe.in>',
      to:      "info@printe.in",
      subject: `New Inquiry from ${values.name}`,
      html: `
        <div style="font-family:Arial,sans-serif;padding:20px;background-color:#f9f9f9;">
          <div style="max-width:600px;background:white;padding:20px;border-radius:10px;box-shadow:0 3px 12px rgba(0,0,0,0.1);">
            <h2 style="background:#f2c41a;color:white;padding:12px;border-radius:5px;text-align:center;font-size:20px;">
              📩 New Inquiry Notification
            </h2>
            <p style="font-size:16px;color:#333;">
              <strong>Name:</strong> ${values.name}<br>
              <strong>Email:</strong> ${values.email}<br>
              <strong>Phone:</strong> ${values.phone}<br>
              <strong>Message:</strong><br>${values.message}
            </p>
            <hr style="border:0;border-top:1px solid #ddd;">
            <p style="text-align:center;font-size:14px;color:#666;">
              Thank you for reaching out! Our team will get back to you soon.
            </p>
          </div>
        </div>
      `,
    });
    console.log("✅ Inquiry email sent successfully");
    return true;
  } catch (err) {
    console.log("❌ Error sending inquiry email:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// Order Placed Mail
// ─────────────────────────────────────────────

const orderMail = async (values) => {
  try {
    const { subject, template } = TemplateHelper({ ...values, target: "placed order" });
    await webmailTransporter.sendMail({
      from:    '"Printe" <info@printe.in>',
      to:      values?.delivery_address?.email,
      subject,
      html:    template,
    });
    console.log("✅ Order email sent successfully");
    return true;
  } catch (err) {
    console.error("❌ Error sending order email:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// Order Status Mail
// ─────────────────────────────────────────────

const orderStatusMail = async (values) => {
  try {
    const { subject, template } = TemplateHelper({ ...values, target: "order status" });
    await webmailTransporter.sendMail({
      from:    '"Printe" <info@printe.in>',
      to:      values?.delivery_address?.email,
      subject,
      html:    template,
    });
    console.log("✅ Order status email sent successfully");
    return true;
  } catch (err) {
    console.log("❌ Error sending order status email:", err.message);
    return false;
  }
};

// ─────────────────────────────────────────────
// Cart Abandonment Reminder Mail
//
// ⚠ IMPORTANT: This function THROWS on failure so the cron job's
// try/catch can catch it and log properly. Do NOT swallow the error here.
// ─────────────────────────────────────────────

const cartAbandonmentMail = async (email, cartItems) => {
  const itemRows = cartItems
    .map(
      (item) => `
        <tr>
          <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;">
            ${
              item.product_image
                ? `<img src="${item.product_image}" alt=""
                       style="width:52px;height:52px;object-fit:cover;border-radius:6px;
                              vertical-align:middle;margin-right:10px;">`
                : ""
            }
            <span style="font-size:14px;color:#333;vertical-align:middle;">
              ${item.product_name || "Product"}
            </span>
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:center;
                      font-size:14px;color:#555;">
            ${item.quantity}
          </td>
          <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:right;
                      font-size:14px;color:#333;">
            ${item.product_price ? `&#8377;${item.product_price}` : "&mdash;"}
          </td>
        </tr>`
    )
    .join("");

  // Throws on SMTP failure — caller handles the error
  await webmailTransporter.sendMail({
    from:    '"Printe" <info@printe.in>',
    to:      email,
    subject: "🛒 You left something in your cart — Printe",
    html: `
      <div style="font-family:Arial,sans-serif;padding:20px;background-color:#f9f9f9;">
        <div style="max-width:600px;background:white;padding:30px;border-radius:10px;
                    box-shadow:0 3px 12px rgba(0,0,0,0.1);margin:0 auto;">

          <div style="text-align:center;margin-bottom:25px;">
            <img fetchpriority="high" loading="eager"
                 src="https://printe.in/assets/logo-BQbty1hL.png"
                 alt="Printe Logo"
                 style="max-height:70px;width:auto;display:block;margin:0 auto;" />
          </div>

          <h2 style="background:#f2c41a;color:#000;padding:15px;border-radius:5px;
                      text-align:center;font-size:22px;margin:0 0 20px;">
            You left something in your cart!
          </h2>

          <p style="font-size:15px;color:#333;margin-bottom:20px;">
            Hi there,<br><br>
            Looks like you added items to your cart but didn't complete the purchase.
            Your cart is saved and waiting for you:
          </p>

          <table width="100%" cellpadding="0" cellspacing="0"
                 style="border-collapse:collapse;margin-bottom:24px;">
            <thead>
              <tr style="background:#f8f8f8;">
                <th style="padding:10px 8px;text-align:left;font-size:13px;
                            color:#666;font-weight:600;border-bottom:2px solid #f2c41a;">
                  Product
                </th>
                <th style="padding:10px 8px;text-align:center;font-size:13px;
                            color:#666;font-weight:600;border-bottom:2px solid #f2c41a;">
                  Qty
                </th>
                <th style="padding:10px 8px;text-align:right;font-size:13px;
                            color:#666;font-weight:600;border-bottom:2px solid #f2c41a;">
                  Price
                </th>
              </tr>
            </thead>
            <tbody>
              ${itemRows}
            </tbody>
          </table>

          <div style="text-align:center;margin:28px 0;">
            <a href="${process.env.FRONTEND_URL || "https://printe.in"}/cart"
               style="background:#f2c41a;color:#000;padding:14px 32px;
                      text-decoration:none;border-radius:6px;display:inline-block;
                      font-size:16px;font-weight:bold;">
              Complete Your Purchase &rarr;
            </a>
          </div>

          <p style="font-size:13px;color:#888;text-align:center;">
            This reminder is sent only once. Your cart will be held for 24 hours.
          </p>

          <hr style="border:0;border-top:1px solid #ddd;margin:25px 0;">

          <div style="text-align:center;background:#060606;padding:10px;border-radius:8px;">
            <h3 style="color:#fff;margin-bottom:6px;font-size:16px;">Contact Information</h3>
            <div style="font-size:14px;color:#fff;">
              <p style="margin:4px 0;">
                <strong>Email:</strong>
                <a href="mailto:info@printe.in" style="color:#f2c41a;text-decoration:none;">
                  info@printe.in
                </a>
                &nbsp;&nbsp;
                <strong>Website:</strong>
                <a href="https://printe.in/" style="color:#f2c41a;text-decoration:none;">
                  printe.in
                </a>
                &nbsp;&nbsp;
                <strong>Phone:</strong> +91 95856 10000
              </p>
            </div>
          </div>

          <hr style="border:0;border-top:1px solid #ddd;margin:25px 0;">

          <div style="text-align:center;font-size:12px;color:#999;">
            <p style="margin:5px 0;">
              If you've already placed your order, please ignore this email.
            </p>
            <p style="margin:5px 0;">
              This is an automated message from Printe. Please do not reply.
            </p>
            <p style="margin:10px 0;font-size:11px;color:#777;">
              &copy; ${new Date().getFullYear()} Printe. All rights reserved.
            </p>
          </div>

        </div>
      </div>
    `,
  });

  console.log("✅ Cart abandonment email sent to:", email);
};

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  webmailTransporter,
  sendMail,
  BNIwelcome,
  otpMail,
  inquiryMail,
  orderMail,
  orderStatusMail,
  cartAbandonmentMail,
};