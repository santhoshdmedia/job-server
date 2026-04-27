const express = require('express');
const router = express.Router();
const Warranty = require('../modals/warrenty.modal');

// Generate batch (Frontend will handle QR generation)
router.post('/generate-batch', async (req, res) => {
    try {
        const {
            productName,
            productModel,
            batchNumber,
            manufacturingDate,
            quantity = 500,
            warrantyDuration = 6,
            warrantyType = 'standard'
        } = req.body;

        // Validate quantity
        if (quantity <= 0 || quantity > 500) {
            return res.status(400).json({
                success: false,
                message: 'Quantity must be between 1 and 500'
            });
        }

        // Generate batch ID
        const batchId = `BATCH${Date.now().toString(36).toUpperCase()}`;
        
        const warranties = [];
        const generatedCodes = [];

        console.log(`Generating ${quantity} warranty codes for batch ${batchNumber}...`);

        for (let i = 0; i < quantity; i++) {
            // Generate unique product code
            const uniqueCode = generateUniqueCode(productName, batchNumber, i + 1);
            
            // Create warranty record (NOT ACTIVATED YET)
            const warranty = new Warranty({
                productUniqueCode: uniqueCode,
                productName,
                productModel,
                batchNumber,
                manufacturingDate: new Date(manufacturingDate),
                warrantyDuration,
                warrantyType,
                isActivated: false, // Will be activated when purchased
                isVerified: false
            });

            warranties.push(warranty);
            
            generatedCodes.push({
                index: i + 1,
                productUniqueCode: uniqueCode,
                productName,
                productModel,
                batchNumber
            });

            // Log progress
            if ((i + 1) % 100 === 0) {
                console.log(`Generated ${i + 1}/${quantity} codes`);
            }
        }

        // Save all warranties to database
        await Warranty.insertMany(warranties);

        console.log(`✅ Successfully generated ${quantity} warranty codes for batch ${batchNumber}`);

        res.status(201).json({
            success: true,
            message: `Batch generated successfully with ${quantity} products`,
            data: {
                batchId,
                batchNumber,
                productName,
                productModel,
                manufacturingDate,
                warrantyDuration: `${warrantyDuration} months`,
                totalCodes: quantity,
                sampleCodes: generatedCodes.slice(0, 10), // Show first 10 codes as sample
                instructions: {
                    qrGeneration: 'Generate QR codes on frontend using these product codes',
                    verification: 'Use /api/warranty/verify/:code to verify',
                    activation: 'Use /api/warranty/activate/:code to activate warranty'
                }
            }
        });

    } catch (error) {
        console.error('Batch generation error:', error);
        
        // Handle duplicate key errors
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'Duplicate product codes detected. Please try again.'
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Failed to generate batch',
            error: error.message
        });
    }
});

// Helper function to generate unique code
function generateUniqueCode(productName, batchNumber, sequence) {
    const prefix = productName.substring(0, 3).toUpperCase();
    const timestamp = Date.now().toString(36).toUpperCase().substring(0, 4);
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${timestamp}${random}`;
}

// VERIFY WARRANTY CODE (Main endpoint - used when scanning QR or entering code)
router.get('/verify/:code', async (req, res) => {
    try {
        const { code } = req.params;
        
        // Find warranty by product code
        const warranty = await Warranty.findOne({ productUniqueCode: code });
        
        if (!warranty) {
            return res.status(404).json({
                success: false,
                message: 'Invalid warranty code',
                code: code,
                suggestion: 'Please check the code and try again'
            });
        }

        // Update verification stats
        warranty.isVerified = true;
        warranty.verifiedAt = new Date();
        warranty.verificationCount = (warranty.verificationCount || 0) + 1;
        warranty.lastVerifiedAt = new Date();

        await warranty.save();

        // Prepare response data
        const response = {
            success: true,
            verification: {
                isValid: true,
                productCode: warranty.productUniqueCode,
                verificationId: warranty._id.toString().substring(0, 12),
                timestamp: new Date().toISOString(),
                verificationCount: warranty.verificationCount
            },
            product: {
                name: warranty.productName,
                model: warranty.productModel,
                batchNumber: warranty.batchNumber,
                manufacturingDate: warranty.manufacturingDate.toISOString().split('T')[0],
                isActivated: warranty.isActivated
            },
            warranty: {
                duration: `${warranty.warrantyDuration} months`,
                type: warranty.warrantyType,
                status: getWarrantyStatus(warranty)
            }
        };

        // If warranty is activated, add activation details
        if (warranty.isActivated) {
            response.warranty.startDate = warranty.warrantyStartDate.toISOString().split('T')[0];
            response.warranty.endDate = warranty.warrantyEndDate.toISOString().split('T')[0];
            
            // Calculate days remaining
            const now = new Date();
            const endDate = new Date(warranty.warrantyEndDate);
            const daysRemaining = Math.max(0, Math.floor((endDate - now) / (1000 * 60 * 60 * 24)));
            response.warranty.daysRemaining = daysRemaining;
            response.warranty.isActive = now <= endDate;
            
            // Add customer info if available
            if (warranty.customerName) {
                response.customer = {
                    name: warranty.customerName,
                    isRegistered: true
                };
            }
        } else {
            response.warranty.message = 'Warranty not activated yet';
            response.warranty.activationRequired = true;
        }

        res.json(response);

    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({
            success: false,
            message: 'Verification failed',
            error: error.message
        });
    }
});

// Helper function to get warranty status
function getWarrantyStatus(warranty) {
    if (!warranty.isActivated) return 'not-activated';
    
    const now = new Date();
    const endDate = new Date(warranty.warrantyEndDate);
    
    if (now > endDate) return 'expired';
    if (now > new Date(endDate.getTime() - (30 * 24 * 60 * 60 * 1000))) return 'expiring-soon';
    return 'active';
}

// ACTIVATE WARRANTY (When product is purchased)
router.post('/activate/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const {
            customerName,
            customerEmail,
            customerPhone,
            purchaseDate,
            retailerName,
            invoiceNumber
        } = req.body;

        // Find warranty by product code
        const warranty = await Warranty.findOne({ productUniqueCode: code });
        
        if (!warranty) {
            return res.status(404).json({
                success: false,
                message: 'Invalid warranty code'
            });
        }

        // Check if already activated
        if (warranty.isActivated) {
            return res.status(400).json({
                success: false,
                message: 'Warranty already activated',
                data: {
                    activationDate: warranty.activationDate,
                    warrantyStartDate: warranty.warrantyStartDate
                }
            });
        }

        // Validate required fields for activation
        if (!customerName || !purchaseDate) {
            return res.status(400).json({
                success: false,
                message: 'Customer name and purchase date are required for activation'
            });
        }

        const now = new Date();
        const purchaseDateObj = new Date(purchaseDate);
        
        // Set activation details
        warranty.isActivated = true;
        warranty.activationDate = now;
        warranty.warrantyStartDate = purchaseDateObj;
        
        // Calculate warranty end date (6 months from purchase)
        const warrantyEndDate = new Date(purchaseDateObj);
        warrantyEndDate.setMonth(warrantyEndDate.getMonth() + warranty.warrantyDuration);
        warranty.warrantyEndDate = warrantyEndDate;
        
        // Add customer information
        warranty.customerName = customerName;
        warranty.customerEmail = customerEmail;
        warranty.customerPhone = customerPhone;
        warranty.purchaseDate = purchaseDateObj;
        warranty.retailerName = retailerName;
        warranty.invoiceNumber = invoiceNumber;

        await warranty.save();

        // Calculate days remaining
        const daysRemaining = Math.max(0, Math.floor((warrantyEndDate - now) / (1000 * 60 * 60 * 24)));

        res.json({
            success: true,
            message: 'Warranty activated successfully',
            data: {
                productCode: warranty.productUniqueCode,
                customerName: warranty.customerName,
                activationDate: warranty.activationDate.toISOString().split('T')[0],
                warrantyStartDate: warranty.warrantyStartDate.toISOString().split('T')[0],
                warrantyEndDate: warranty.warrantyEndDate.toISOString().split('T')[0],
                warrantyDuration: `${warranty.warrantyDuration} months`,
                daysRemaining: daysRemaining,
                warrantyStatus: 'active'
            }
        });

    } catch (error) {
        console.error('Activation error:', error);
        res.status(500).json({
            success: false,
            message: 'Activation failed',
            error: error.message
        });
    }
});

// CHECK WARRANTY STATUS (Quick status check)
router.get('/status/:code', async (req, res) => {
    try {
        const { code } = req.params;
        
        const warranty = await Warranty.findOne({ productUniqueCode: code })
            .select('productName productModel isActivated warrantyStartDate warrantyEndDate warrantyDuration isClaimed');
        
        if (!warranty) {
            return res.status(404).json({
                success: false,
                message: 'Warranty code not found'
            });
        }

        const response = {
            success: true,
            data: {
                productCode: code,
                product: `${warranty.productName} ${warranty.productModel}`,
                isActivated: warranty.isActivated,
                warrantyStatus: getWarrantyStatus(warranty)
            }
        };

        if (warranty.isActivated) {
            const now = new Date();
            const endDate = new Date(warranty.warrantyEndDate);
            const daysRemaining = Math.max(0, Math.floor((endDate - now) / (1000 * 60 * 60 * 24)));
            
            response.data.warrantyStartDate = warranty.warrantyStartDate.toISOString().split('T')[0];
            response.data.warrantyEndDate = warranty.warrantyEndDate.toISOString().split('T')[0];
            response.data.daysRemaining = daysRemaining;
            response.data.isActive = now <= endDate;
            response.data.isClaimed = warranty.isClaimed || false;
        }

        res.json(response);

    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check warranty status',
            error: error.message
        });
    }
});

// UPDATE WARRANTY (For customer info updates)
router.put('/update/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const updates = req.body;

        const warranty = await Warranty.findOne({ productUniqueCode: code });
        
        if (!warranty) {
            return res.status(404).json({
                success: false,
                message: 'Warranty code not found'
            });
        }

        // Allowed fields to update
        const allowedUpdates = ['customerName', 'customerEmail', 'customerPhone', 'retailerName', 'invoiceNumber'];
        
        allowedUpdates.forEach(field => {
            if (updates[field] !== undefined) {
                warranty[field] = updates[field];
            }
        });

        await warranty.save();

        res.json({
            success: true,
            message: 'Warranty information updated',
            data: {
                productCode: warranty.productUniqueCode,
                customerName: warranty.customerName,
                customerEmail: warranty.customerEmail,
                updatedAt: warranty.updatedAt
            }
        });

    } catch (error) {
        console.error('Update error:', error);
        res.status(500).json({
            success: false,
            message: 'Update failed',
            error: error.message
        });
    }
});

// CLAIM WARRANTY (Submit warranty claim)
router.post('/claim/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const {
            issueType,
            description,
            customerName,
            customerEmail,
            contactPhone
        } = req.body;

        const warranty = await Warranty.findOne({ productUniqueCode: code });
        
        if (!warranty) {
            return res.status(404).json({
                success: false,
                message: 'Warranty code not found'
            });
        }

        // Check if warranty is activated
        if (!warranty.isActivated) {
            return res.status(400).json({
                success: false,
                message: 'Warranty must be activated before making a claim'
            });
        }

        // Check if warranty is still valid
        const now = new Date();
        if (now > warranty.warrantyEndDate) {
            return res.status(400).json({
                success: false,
                message: 'Warranty has expired'
            });
        }

        if (warranty.isClaimed) {
            return res.status(400).json({
                success: false,
                message: 'A claim already exists for this warranty'
            });
        }

        // Create claim
        warranty.isClaimed = true;
        warranty.claimDate = now;
        warranty.claimDetails = {
            issueType,
            description,
            claimedAt: now,
            status: 'pending'
        };

        // Update customer info if provided
        if (customerName) warranty.customerName = customerName;
        if (customerEmail) warranty.customerEmail = customerEmail;
        if (contactPhone) warranty.customerPhone = contactPhone;

        await warranty.save();

        res.json({
            success: true,
            message: 'Warranty claim submitted successfully',
            data: {
                claimId: warranty._id,
                claimDate: warranty.claimDate,
                status: warranty.claimDetails.status,
                referenceCode: `CLAIM-${code.substring(0, 8)}`
            }
        });

    } catch (error) {
        console.error('Claim error:', error);
        res.status(500).json({
            success: false,
            message: 'Claim submission failed',
            error: error.message
        });
    }
});

// BATCH STATUS (Check all codes in a batch)
router.get('/batch/:batchNumber', async (req, res) => {
    try {
        const { batchNumber } = req.params;
        
        const warranties = await Warranty.find({ batchNumber })
            .select('productUniqueCode isActivated activationDate customerName isClaimed createdAt')
            .sort({ createdAt: 1 })
            .limit(500);

        if (!warranties || warranties.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Batch not found'
            });
        }

        const summary = {
            batchNumber,
            totalProducts: warranties.length,
            activatedProducts: warranties.filter(w => w.isActivated).length,
            claimedProducts: warranties.filter(w => w.isClaimed).length,
            products: warranties.map(w => ({
                code: w.productUniqueCode,
                isActivated: w.isActivated,
                activationDate: w.activationDate,
                customerName: w.customerName,
                isClaimed: w.isClaimed,
                createdAt: w.createdAt
            }))
        };

        res.json({
            success: true,
            data: summary
        });

    } catch (error) {
        console.error('Batch status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get batch status',
            error: error.message
        });
    }
});

// EXPORT BATCH CODES as CSV
router.get('/export/:batchNumber', async (req, res) => {
    try {
        const { batchNumber } = req.params;
        
        const warranties = await Warranty.find({ batchNumber })
            .select('productUniqueCode productName productModel manufacturingDate')
            .sort({ createdAt: 1 });

        if (!warranties || warranties.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Batch not found'
            });
        }

        // Generate CSV
        let csv = 'Product Code,Product Name,Product Model,Manufacturing Date\n';
        warranties.forEach(w => {
            csv += `${w.productUniqueCode},${w.productName},${w.productModel},${w.manufacturingDate.toISOString().split('T')[0]}\n`;
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="warranty-codes-${batchNumber}.csv"`);
        res.send(csv);

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to export codes',
            error: error.message
        });
    }
});

// BULK ACTIVATE (Activate multiple codes at once - for retailers)
router.post('/bulk-activate', async (req, res) => {
    try {
        const { codes, purchaseDate, retailerName } = req.body;

        if (!codes || !Array.isArray(codes) || codes.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Product codes array is required'
            });
        }

        if (!purchaseDate) {
            return res.status(400).json({
                success: false,
                message: 'Purchase date is required'
            });
        }

        const results = [];
        const errors = [];

        for (const code of codes) {
            try {
                const warranty = await Warranty.findOne({ productUniqueCode: code });
                
                if (!warranty) {
                    errors.push({ code, error: 'Code not found' });
                    continue;
                }

                if (warranty.isActivated) {
                    errors.push({ code, error: 'Already activated' });
                    continue;
                }

                // Activate the warranty
                const now = new Date();
                const purchaseDateObj = new Date(purchaseDate);
                
                warranty.isActivated = true;
                warranty.activationDate = now;
                warranty.warrantyStartDate = purchaseDateObj;
                
                const warrantyEndDate = new Date(purchaseDateObj);
                warrantyEndDate.setMonth(warrantyEndDate.getMonth() + warranty.warrantyDuration);
                warranty.warrantyEndDate = warrantyEndDate;
                
                warranty.retailerName = retailerName;
                warranty.purchaseDate = purchaseDateObj;

                await warranty.save();

                results.push({
                    code,
                    success: true,
                    activationDate: warranty.activationDate,
                    warrantyEndDate: warranty.warrantyEndDate.toISOString().split('T')[0]
                });

            } catch (error) {
                errors.push({ code, error: error.message });
            }
        }

        res.json({
            success: true,
            summary: {
                totalCodes: codes.length,
                activated: results.length,
                failed: errors.length
            },
            results,
            errors: errors.length > 0 ? errors : undefined
        });

    } catch (error) {
        console.error('Bulk activation error:', error);
        res.status(500).json({
            success: false,
            message: 'Bulk activation failed',
            error: error.message
        });
    }
});

module.exports = router;