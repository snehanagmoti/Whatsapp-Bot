function commandArgument(text, command) {
    if (text === command) return '';
    return text.startsWith(`${command} `) ? text.slice(command.length + 1).trim() : null;
}

async function handleStudioCommand({
    message,
    client,
    routeService,
    canManage = async () => false,
    canSetup = canManage
}) {
    const chatId = message.fromMe ? message.to : message.from;
    const senderId = message.fromMe ? message.senderId || message.to : message.senderId || message.from;
    const text = String(message.body || '').trim();
    const known = ['!setupreport', '!listreportlinks', '!pausereport', '!resumereport', '!rotatereport', '!removereport'];
    if (!known.some(command => text === command || text.startsWith(`${command} `))) return false;

    if (!routeService) {
        await client.sendMessage(chatId, 'Looker Studio email routing is not configured on this bot.');
        return true;
    }
    try {
        const setupName = commandArgument(text, '!setupreport');
        if (setupName !== null) {
            if (!(await canSetup({ chatId, senderId, message }))) {
                await client.sendMessage(chatId, 'Report setup is not available to you.');
                return true;
            }
            if (!setupName || setupName.length > 80) {
                await client.sendMessage(chatId, 'Usage: !setupreport <report name> (maximum 80 characters)');
                return true;
            }
            const created = await routeService.createRoute({ chatId, name: setupName, createdBy: senderId });
            await client.sendMessage(chatId,
                `Report route created for *${created.route.name}*.\n\n` +
                `In Looker Studio, open Share → Schedule delivery → Email and add:\n\n${created.address}\n\n` +
                'Treat this address as a secret. Use !rotatereport if it is exposed.'
            );
            return true;
        }

        if (!(await canManage({ chatId, senderId, message }))) {
            await client.sendMessage(chatId, 'Only an authorized user or group administrator can manage existing report routes.');
            return true;
        }

        if (text === '!listreportlinks') {
            const routes = await routeService.listRoutes(chatId);
            const summary = routes.length
                ? routes.map(route => `• ${route.name} — ${route.status}`).join('\n')
                : 'No Looker Studio report routes are configured for this chat.';
            await client.sendMessage(chatId, summary);
            return true;
        }

        for (const [command, status, successWord] of [
            ['!pausereport', 'paused', 'paused'],
            ['!resumereport', 'active', 'resumed']
        ]) {
            const name = commandArgument(text, command);
            if (name !== null) {
                if (!name) {
                    await client.sendMessage(chatId, `Usage: ${command} <report name>`);
                    return true;
                }
                const route = await routeService.setRouteStatus(chatId, name, status);
                await client.sendMessage(chatId, route ? `Report route *${route.name}* ${successWord}.` : 'Report route not found.');
                return true;
            }
        }

        const rotateName = commandArgument(text, '!rotatereport');
        if (rotateName !== null) {
            if (!rotateName) {
                await client.sendMessage(chatId, 'Usage: !rotatereport <report name>');
                return true;
            }
            const rotated = await routeService.rotateRoute(chatId, rotateName);
            await client.sendMessage(chatId, rotated
                ? `Route rotated for *${rotated.route.name}*. Replace the old Looker Studio recipient with:\n\n${rotated.address}`
                : 'Report route not found.');
            return true;
        }

        const removeName = commandArgument(text, '!removereport');
        if (removeName !== null) {
            if (!removeName) {
                await client.sendMessage(chatId, 'Usage: !removereport <report name> --confirm');
                return true;
            }
            const confirmation = /^(.*?)\s+--confirm$/i.exec(removeName);
            if (!confirmation || !confirmation[1].trim()) {
                await client.sendMessage(
                    chatId,
                    `This permanently removes the route for *${removeName}*. To continue, send:\n\n` +
                    `!removereport ${removeName} --confirm`
                );
                return true;
            }
            const confirmedName = confirmation[1].trim();
            const removed = await routeService.removeRoute(chatId, confirmedName);
            await client.sendMessage(chatId, removed ? `Report route *${confirmedName}* removed.` : 'Report route not found.');
            return true;
        }
    } catch (error) {
        const duplicate = error && error.code === 11000;
        const quotaExceeded = error && error.code === 'ROUTE_QUOTA_EXCEEDED';
        await client.sendMessage(chatId,
            duplicate
                ? 'A report route with that name already exists. Use !rotatereport to replace its address.'
                : quotaExceeded
                    ? `${error.message} Remove an unused route before creating another.`
                    : `Could not update the report route: ${error.message || error}`
        );
        return true;
    }
    return false;
}

module.exports = { commandArgument, handleStudioCommand };
