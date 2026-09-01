const express = require('express');
const path = require('path');
const { authenticateSession } = require('./screenshot');

function startServer(client) {
    const app = express();
    const port = process.env.PORT || 3000;

    app.use(express.urlencoded({ extended: true })); // to support URL-encoded bodies
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

    app.listen(port, () => {
        console.log(`Web portal running on http://localhost:${port}`);
    });
}

module.exports = { startServer };
