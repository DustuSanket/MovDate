import { useEffect, useRef, useState } from 'react';

const POLL_MS = 2000;

// Polls every connected RTCPeerConnection's getStats() to derive a rough
// live ping (avg RTT across active candidate pairs) plus aggregate
// download/upload throughput (bytes across inbound/outbound RTP + data
// channel reports, converted to a per-second rate between polls).
export function useNetworkStats(peerConnectionsRef, enabled = true) {
  const [stats, setStats] = useState({ pingMs: null, downloadKbps: 0, uploadKbps: 0, hasPeers: false });
  const prevRef = useRef({ received: 0, sent: 0, time: 0 });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    async function poll() {
      const pcs = peerConnectionsRef?.current;
      if (!pcs || pcs.size === 0) {
        prevRef.current = { received: 0, sent: 0, time: 0 };
        if (!cancelled) setStats({ pingMs: null, downloadKbps: 0, uploadKbps: 0, hasPeers: false });
        return;
      }

      let totalReceived = 0;
      let totalSent = 0;
      let rttSum = 0;
      let rttCount = 0;
      let anyActive = false;

      for (const pc of pcs.values()) {
        const iceState = pc.iceConnectionState;
        if (iceState !== 'connected' && iceState !== 'completed') continue;
        anyActive = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          const reports = await pc.getStats();
          reports.forEach((report) => {
            if (
              (report.type === 'inbound-rtp' || report.type === 'data-channel') &&
              typeof report.bytesReceived === 'number'
            ) {
              totalReceived += report.bytesReceived;
            }
            if (
              (report.type === 'outbound-rtp' || report.type === 'data-channel') &&
              typeof report.bytesSent === 'number'
            ) {
              totalSent += report.bytesSent;
            }
            if (
              report.type === 'candidate-pair' &&
              (report.state === 'succeeded' || report.nominated) &&
              typeof report.currentRoundTripTime === 'number'
            ) {
              rttSum += report.currentRoundTripTime * 1000;
              rttCount += 1;
            }
          });
        } catch {
          // getStats can throw briefly during teardown/renegotiation — ignore.
        }
      }

      const now = performance.now();
      const prev = prevRef.current;
      const dt = (now - prev.time) / 1000;

      if (!cancelled) {
        setStats((current) => {
          const pingMs = rttCount ? Math.round(rttSum / rttCount) : anyActive ? current.pingMs : null;
          if (!prev.time || dt <= 0) {
            return { pingMs, downloadKbps: current.downloadKbps, uploadKbps: current.uploadKbps, hasPeers: anyActive };
          }
          const downloadKbps = Math.max(0, ((totalReceived - prev.received) * 8) / 1000 / dt);
          const uploadKbps = Math.max(0, ((totalSent - prev.sent) * 8) / 1000 / dt);
          return { pingMs, downloadKbps, uploadKbps, hasPeers: anyActive };
        });
      }

      prevRef.current = { received: totalReceived, sent: totalSent, time: now };
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [peerConnectionsRef, enabled]);

  return stats;
}
