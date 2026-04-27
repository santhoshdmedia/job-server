const Lead = require("../modals/lead.modals");

/**
 * Generate unique Lead ID in format: SMJAN25001
 * SM - Source Abbreviation, JAN - Month, 25 - Year, 001 - Sequence
 */
const generateLeadId = async (source = "SM") => {
  try {
    // Source abbreviations
    const sourceMap = {
      "Social Media": "SM",
      "Website": "WB",
      "Referral": "RF",
      "Walk-in": "WI",
      "Other": "OT"
    };

    const sourceAbbr = sourceMap[source] || "SM";
    
    // Get current month and year
    const now = new Date();
    const monthAbbr = now.toLocaleString('en-US', { month: 'short' }).toUpperCase();
    const yearShort = now.getFullYear().toString().slice(-2);
    
    // Create prefix
    const prefix = `${sourceAbbr}${monthAbbr}${yearShort}`;
    
    // Find the highest sequence number for this prefix
    const regex = new RegExp(`^${prefix}\\d{3}$`);
    const lastLead = await Lead.findOne(
      { Lead_Id: regex },
      { Lead_Id: 1 },
      { sort: { Lead_Id: -1 } }
    );
    
    let sequence = 1; // Start from 001
    
    if (lastLead && lastLead.Lead_Id) {
      const lastSequence = parseInt(lastLead.Lead_Id.slice(-3));
      sequence = lastSequence + 1;
    }
    
    // Format sequence to 3 digits
    const sequenceStr = sequence.toString().padStart(3, '0');
    
    return `${prefix}${sequenceStr}`;
  } catch (error) {
    console.error("Error generating Lead ID:", error);
    // Fallback ID
    const fallbackId = `${sourceAbbr}${monthAbbr}${yearShort}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
    return fallbackId;
  }
};

module.exports = { generateLeadId };