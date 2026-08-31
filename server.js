
const express = require("express");
const cors = require("cors");

const {
    router: instagramDownloaderRouter,
    initializeInstagramDownloader,
} = require("./routes/instagramDownloader");

const app = express();

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const PORT = Number(process.env.PORT || 5050);

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(
    cors({
        origin: true,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: [
            "Content-Type",
            "Authorization",
        ],
    })
);

app.use(
    express.json({
        limit: "1mb",
    })
);

app.use(
    express.urlencoded({
        extended: true,
    })
);

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Instagram API is running.",
        server: `http://127.0.0.1:${PORT}`,
    });
});

/*
|--------------------------------------------------------------------------
| API Routes
|--------------------------------------------------------------------------
*/

/*
 * Instagram Video Downloader
 *
 * Example:
 *
 * POST /api/instagram/download/video
 */
app.use(
    "/api/instagram",
    instagramDownloaderRouter
);
                                       
/*
|--------------------------------------------------------------------------
| 404 Handler
|--------------------------------------------------------------------------
|
| IMPORTANT:
| Keep this AFTER all API routes.
|
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "Endpoint not found.",
        path: req.originalUrl,
    });
});

/*
|--------------------------------------------------------------------------
| Global Error Handler
|--------------------------------------------------------------------------
*/

app.use(
    (error, req, res, next) => {
        console.error(
            "[SERVER ERROR]",
            error
        );

        if (res.headersSent) {
            return next(error);
        }

        res.status(500).json({
            success: false,
            error: "Internal server error.",
        });
    }
);

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

async function startServer() {
    try {
        /*
         * Initialize Instagram downloader.
         *
         * This can check dependencies and create
         * required temporary directories.
         */
        await initializeInstagramDownloader();

        console.log(
            "============================================================"
        );

        console.log(
            "Instagram API - Node.js"
        );

        console.log(
            "============================================================"
        );

        console.log(
            `Server: http://127.0.0.1:${PORT}`
        );

        console.log(
            "------------------------------------------------------------"
        );

        console.log(
            "Video Downloader:"
        );

        console.log(
            `POST http://127.0.0.1:${PORT}/api/instagram/download/video`
        );

        console.log(
            "------------------------------------------------------------"
        );

        console.log(
            "Instagram Stories:"
        );

        console.log(
            `GET http://127.0.0.1:${PORT}/api/instagram/stories/:username`
        );

        console.log(
            "============================================================"
        );

        app.listen(
            PORT,
            "127.0.0.1",
            () => {
                console.log(
                    `API running on port ${PORT}`
                );

                console.log(
                    "=================================================="
                );
            }
        );
    } catch (error) {
        console.error(
            "Failed to start server:",
            error
        );

        process.exit(1);
    }
}

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

startServer();

