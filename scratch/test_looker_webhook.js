const http = require('http');

const chatId = process.env.LOOKER_TEST_CHAT_ID;
const actionToken = process.env.LOOKER_ACTION_TOKEN;
if (!chatId || !actionToken) {
  throw new Error('Set LOOKER_TEST_CHAT_ID and LOOKER_ACTION_TOKEN before running this script.');
}

const payload = JSON.stringify({
  type: "dashboard",
  scheduled_plan: {
    title: "Test Dashboard"
  },
  attachment: {
    mimetype: "image/png",
    extension: "png",
    // This is a base64 encoded 1x1 transparent pixel (valid PNG)
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  },
  form_params: {
    chatId,
    customMessage: "✅ Automated Webhook Test: Successfully received Looker payload!"
  }
});

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/looker/execute',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    Authorization: `Token token="${actionToken}"`
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.setEncoding('utf8');
  res.on('data', (chunk) => {
    console.log(`BODY: ${chunk}`);
  });
});

req.on('error', (e) => {
  console.error(`Problem with request: ${e.message}`);
});

req.write(payload);
req.end();
