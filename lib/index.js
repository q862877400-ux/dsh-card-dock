// @local/dsh-card-dock/lib/index.js — Standalone DeepSeek-Bar & Live Browser Twin Host Plugin (v1.0.0)
// Completely independent of CAD/SolidWorks: works in ANY DeepSeek Harness (DSH >= 0.2.2) profile!
// Provides same-host SSE + JSON twin state relay (/dsh-card-dock/events, /dsh-card-dock/sync, /dsh-card-dock/state)
// so even an isolated --user-data-dir Chromium --app bubble stays 100% synchronized in real time with the main DSH window.

export const name = 'dsh-card-dock';
export const inject = ['webServer'];

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        rejectBody(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

const twinState = {
  seq: 1,
  updatedAt: Date.now(),
  sourceClientId: '',
  dshOrigin: '',
  sessionPath: '/',
  sessionId: '',
  draft: '',
  agentName: 'Agent',
  widthPx: 780,
  expandedHeightPx: 280,
  desiredHeightPx: 146,
  drawerExpanded: false,
  popupOpen: false,
  pinned: false,
  pendingQuotes: [],
  sseClients: new Set(),
};

function broadcastTwinEvent(eventName, payload) {
  const frame = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const clientRes of twinState.sseClients) {
    try {
      clientRes.write(frame);
    } catch {
      twinState.sseClients.delete(clientRes);
    }
  }
}

export function apply(ctx) {
  // 1. SSE real-time stream for Twin Composer synchronization (draft, sessionPath, quotes, width)
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-card-dock/events',
    handler(req, res) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(
        'event: snapshot\ndata: ' +
          JSON.stringify({
            seq: twinState.seq,
            sourceClientId: twinState.sourceClientId,
            sessionPath: twinState.sessionPath,
            sessionId: twinState.sessionId,
            draft: twinState.draft,
            agentName: twinState.agentName,
            widthPx: twinState.widthPx,
            expandedHeightPx: twinState.expandedHeightPx,
            desiredHeightPx: twinState.desiredHeightPx,
            pinned: twinState.pinned,
          }) +
          '\n\n',
      );
      twinState.sseClients.add(res);
      req.on('close', () => {
        twinState.sseClients.delete(res);
      });
    },
  });

  // 2. Pollable state endpoint for desktop-launcher/dsh_browser_bubble.py
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-card-dock/state',
    handler(_req, res) {
      sendJson(res, 200, {
        ok: true,
        version: '1.0.0',
        seq: twinState.seq,
        updatedAt: twinState.updatedAt,
        dshOrigin: twinState.dshOrigin,
        sessionPath: twinState.sessionPath,
        sessionId: twinState.sessionId,
        draft: twinState.draft,
        agentName: twinState.agentName,
        widthPx: twinState.widthPx,
        expandedHeightPx: twinState.expandedHeightPx,
        desiredHeightPx: twinState.desiredHeightPx,
        drawerExpanded: twinState.drawerExpanded,
        popupOpen: twinState.popupOpen,
        pinned: twinState.pinned,
      });
    },
  });

  // 3. Bidirectional live twin state update (from either Main DSH Web UI or ?dsh_bar_clone=1 Bubble Twin)
  ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-card-dock/sync',
    async handler(req, res) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        let shouldBroadcast = false;

        if (typeof body.clientId === 'string') {
          twinState.sourceClientId = body.clientId;
        }
        if (typeof body.dshOrigin === 'string' && body.dshOrigin) {
          twinState.dshOrigin = body.dshOrigin.replace(/\/+$/, '');
        }
        if (typeof body.sessionPath === 'string' && body.sessionPath.startsWith('/')) {
          if (twinState.sessionPath !== body.sessionPath) {
            twinState.sessionPath = body.sessionPath;
            shouldBroadcast = true;
          }
        }
        if (typeof body.sessionId === 'string' && twinState.sessionId !== body.sessionId) {
          twinState.sessionId = body.sessionId;
          shouldBroadcast = true;
        }
        if (typeof body.draft === 'string' && twinState.draft !== body.draft) {
          twinState.draft = body.draft;
          shouldBroadcast = true;
        }
        if (typeof body.agentName === 'string' && body.agentName.trim()) {
          if (twinState.agentName !== body.agentName.trim()) {
            twinState.agentName = body.agentName.trim();
            shouldBroadcast = true;
          }
        }
        if (typeof body.widthPx === 'number' && Number.isFinite(body.widthPx)) {
          const clampedW = Math.max(420, Math.min(1440, Math.round(body.widthPx)));
          if (twinState.widthPx !== clampedW) {
            twinState.widthPx = clampedW;
            shouldBroadcast = true;
          }
        }
        if (typeof body.expandedHeightPx === 'number' && Number.isFinite(body.expandedHeightPx)) {
          twinState.expandedHeightPx = Math.max(160, Math.min(620, Math.round(body.expandedHeightPx)));
        }
        if (typeof body.desiredHeightPx === 'number' && Number.isFinite(body.desiredHeightPx)) {
          twinState.desiredHeightPx = Math.max(110, Math.min(860, Math.round(body.desiredHeightPx)));
        }
        if (typeof body.drawerExpanded === 'boolean') {
          twinState.drawerExpanded = body.drawerExpanded;
        }
        if (typeof body.popupOpen === 'boolean') {
          twinState.popupOpen = body.popupOpen;
        }
        if (typeof body.pinned === 'boolean' && twinState.pinned !== body.pinned) {
          twinState.pinned = body.pinned;
          shouldBroadcast = true;
        }
        if (typeof body.insertQuoteText === 'string' && body.insertQuoteText.trim()) {
          shouldBroadcast = true;
          twinState.seq += 1;
          twinState.updatedAt = Date.now();
          broadcastTwinEvent('twin-quote', {
            seq: twinState.seq,
            sourceClientId: twinState.sourceClientId,
            quoteText: body.insertQuoteText,
          });
        }

        if (shouldBroadcast) {
          twinState.seq += 1;
          twinState.updatedAt = Date.now();
          broadcastTwinEvent('twin-sync', {
            seq: twinState.seq,
            sourceClientId: twinState.sourceClientId,
            sessionPath: twinState.sessionPath,
            sessionId: twinState.sessionId,
            draft: twinState.draft,
            agentName: twinState.agentName,
            widthPx: twinState.widthPx,
            expandedHeightPx: twinState.expandedHeightPx,
            pinned: twinState.pinned,
          });
        }

        sendJson(res, 200, { ok: true, seq: twinState.seq });
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    },
  });
}
