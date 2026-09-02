const express = require("express");

const router = express.Router();

function getClientIp(req) {
    const forwarded = req.headers["x-forwarded-for"];

    if (forwarded) {
        return forwarded.split(",")[0].trim();
    }

    return (
        req.headers["x-real-ip"] ||
        req.socket?.remoteAddress ||
        req.ip ||
        ""
    ).replace(/^::ffff:/, "");
}

// GET /api/location
router.get("/location", async (req, res) => {
    try {
        const ip = getClientIp(req);

        return res.json({
            success: true,
            ip,
            message: "IP address detected.",
        });
    } catch (error) {
        console.error("[LOCATION GET ERROR]", error);

        return res.status(500).json({
            success: false,
            error: "Unable to get location.",
        });
    }
});

// POST /api/location
router.post("/location", async (req, res) => {
    try {
        const body = req.body || {};

        const latitude = Number(body.latitude);
        const longitude = Number(body.longitude);

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude)
        ) {
            return res.status(400).json({
                success: false,
                error: "Latitude and longitude are required.",
                received: body,
            });
        }

        if (
            latitude < -90 ||
            latitude > 90 ||
            longitude < -180 ||
            longitude > 180
        ) {
            return res.status(400).json({
                success: false,
                error: "Invalid latitude or longitude.",
            });
        }

        const ip = getClientIp(req);

        console.log("==================================================");
        console.log("[USER LOCATION]");
        console.log("IP:", ip);
        console.log("Latitude:", latitude);
        console.log("Longitude:", longitude);
        console.log("==================================================");

        return res.json({
            success: true,
            ip,
            location: {
                latitude,
                longitude,
            },
        });
    } catch (error) {
        console.error("[LOCATION POST ERROR]", error);

        return res.status(500).json({
            success: false,
            error: "Unable to process user location.",
        });
    }
});

module.exports = router;