FROM ghcr.io/puppeteer/puppeteer:latest

# Set up working directory
WORKDIR /usr/src/app

# Switch to root user to copy files and change ownership
USER root
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Change ownership of all files to the non-root pptruser
RUN chown -R pptruser:pptruser /usr/src/app

# Switch back to the non-root user that Puppeteer provides
USER pptruser

# Start the application
CMD [ "npm", "start" ]
