FROM ghcr.io/puppeteer/puppeteer:25.9.0

# Set up working directory
WORKDIR /usr/src/app

# Switch to root user to copy files and change ownership
USER root
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Change ownership of all files to the non-root pptruser
RUN chown -R pptruser:pptruser /usr/src/app

# Switch back to the non-root user that Puppeteer provides
USER pptruser

EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
