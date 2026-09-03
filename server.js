const express = require('express');
const path = require('path');
const { authenticateSession } = require('./screenshot');
const { MessageMedia } = require('whatsapp-web.js');

function startServer(client) {
    const app = express();
    const port = process.env.PORT || 3000;

    app.use(express.urlencoded({ extended: true })); // to support URL-encoded bodies
    app.use(express.json({ limit: '50mb' })); // to support Looker JSON payloads
    app.use(express.static(path.join(__dirname, 'public')));

    app.get('/login', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'login.html'));
    });

    app.post('/auth', async (req, res) => {
        const { chatId, url, cookies } = req.body;

        if (!chatId || !url || !cookies) {
            return res.status(400).send('Missing required fields.');
        }

        res.send(`
            <h2>Session Injection in progress...</h2>
            <p>You can close this window. You will receive a WhatsApp message once the session is successfully saved.</p>
        `);

        try {
            console.log(`Received session cookies for chat ${chatId}. Injecting...`);
            await authenticateSession(url, chatId, cookies);
            client.sendMessage(chatId, `✅ Successfully authenticated for: ${url}\nYou can now use \`!report\` to get screenshots.`);
        } catch (error) {
            console.error('Authentication failed:', error);
            client.sendMessage(chatId, `❌ Failed to authenticate. Please make sure your credentials are correct.`);
        }
    });

    // --- LOOKER ACTION HUB ENDPOINTS ---

    // 1. Action Manifest
    app.get('/actions.json', (req, res) => {
        // In a real production deployment, this URL should be the public domain/IP
        const baseUrl = req.protocol + '://' + req.get('host');
        res.json({
            integrations: [
                {
                    name: "whatsapp_bot",
                    label: "WhatsApp Bot",
                    description: "Send dashboard screenshots directly to a WhatsApp group or user.",
                    url: `${baseUrl}/looker/execute`,
                    supported_action_types: ["query", "dashboard"],
                    supported_formats: ["png"],
                    icon_url: "https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg",
                    params: [],
                    form_url: `${baseUrl}/looker/form`
                }
            ]
        });
    });

    // 2. Action Form Parameters (Requested when a user schedules a report)
    app.post('/looker/form', (req, res) => {
        res.json([
            {
                name: "chatId",
                label: "WhatsApp Chat ID",
                description: "The ID of the WhatsApp group or user to send the screenshot to (e.g. 1234567890@c.us for DM, or 1234567890@g.us for groups).",
                type: "string",
                required: true
            },
            {
                name: "customMessage",
                label: "Custom Message (Optional)",
                description: "Add an optional message to accompany the dashboard screenshot.",
                type: "string",
                required: false
            }
        ]);
    });

    // 3. Action Execution (Receives the payload from Looker)
    app.post('/looker/execute', async (req, res) => {
        const payload = req.body;
        console.log('Received Looker Action execution request.');

        try {
            const formParams = payload.form_params || {};
            const chatId = formParams.chatId;
            
            if (!chatId) {
                console.error("Looker Action failed: Missing WhatsApp Chat ID.");
                return res.json({ looker: { success: false, message: "Missing WhatsApp Chat ID." } });
            }

            const attachment = payload.attachment;
            if (!attachment || !attachment.data) {
                console.error("Looker Action failed: No image attachment found in payload.");
                return res.json({ looker: { success: false, message: "No image attachment found." } });
            }

            // Looker sends the image data as a base64 encoded string
            const imageBase64 = attachment.data; 
            const media = new MessageMedia('image/png', imageBase64, 'looker_dashboard.png');
            
            let caption = "Here is your scheduled Looker dashboard!";
            if (formParams.customMessage) {
                caption = formParams.customMessage;
            }

            console.log(`Sending Looker dashboard to WhatsApp chat ID: ${chatId}`);
            await client.sendMessage(chatId, media, { caption });

            res.json({ looker: { success: true } });
        } catch (error) {
            console.error('Error executing Looker action:', error);
            res.json({ looker: { success: false, message: error.message } });
        }
    });

    app.listen(port, () => {
        console.log(`Web portal running on http://localhost:${port}`);
    });
}

module.exports = { startServer };
