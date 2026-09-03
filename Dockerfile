FROM ghcr.io/puppeteer/puppeteer:25.9.0

# Set up working directory
WORKDIR /usr/src/app

# Switch to root user to copy files and change ownership
USER root
COPY package*.json ./
RUN npm ci --omit=dev

# The base image already contains Chrome, but whatsapp-web.js bundles a
# different Puppeteer revision. Expose the image's browser at a stable path so
# both Puppeteer versions launch the same installed binary without downloading
# a second copy.
RUN CHROME_PATH="$(find /home/pptruser/.cache/puppeteer -type f -name chrome -print -quit)" \
    && test -n "$CHROME_PATH" \
    && ln -sf "$CHROME_PATH" /usr/local/bin/chrome-for-testing
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chrome-for-testing

# Copy application code
COPY . .

# Change ownership of all files to the non-root pptruser
RUN chown -R pptruser:pptruser /usr/src/app

# Switch back to the non-root user that Puppeteer provides
USER pptruser

EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
