@echo off
echo Starting Shopify Staff Assignment App...
echo.
echo Make sure you have:
echo 1. Created a Shopify app in Partner Dashboard
echo 2. Updated your .env file with API credentials
echo 3. Started ngrok in another terminal: ngrok http 3000
echo.
echo Starting the app...
node server.js
