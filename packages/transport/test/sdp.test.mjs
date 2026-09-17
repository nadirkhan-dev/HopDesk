import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sdpFingerprints, assertSecureSdp, certificateFingerprint, certificateMatchesSdp, InsecureSdpError } from '../dist/index.js';

const der = new TextEncoder().encode('abc');
const FP = 'BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD';

// Shape of an offer produced by Chromium for one video transceiver and a data channel.
const chromeSdp = (fp = FP, algo = 'sha-256') => [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdef01234567',
  `a=fingerprint:${algo} ${fp}`, 'a=setup:actpass', 'a=mid:0', 'a=recvonly',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  `a=fingerprint:${algo} ${fp}`, 'a=setup:actpass', 'a=mid:1', 'a=sctp-port:5000', '',
].join('\r\n');

test('certificate fingerprints use the SDP format', () => {
  assert.equal(certificateFingerprint(der), FP);
  assert.deepEqual(sdpFingerprints(chromeSdp()), [{ algorithm: 'sha-256', value: FP }, { algorithm: 'sha-256', value: FP }]);
});

test('secure Chromium-style SDP passes and binds to the presented certificate', () => {
  assert.equal(assertSecureSdp(chromeSdp()).length, 2);
  assert.ok(certificateMatchesSdp(der, chromeSdp()));
  assert.ok(!certificateMatchesSdp(new TextEncoder().encode('abd'), chromeSdp()));
});

test('SDP without DTLS, with weak hashes, conflicting fingerprints or plain RTP is refused', () => {
  assert.throws(() => assertSecureSdp(chromeSdp().replace(/a=fingerprint.*\r\n/g, '')), InsecureSdpError);
  assert.throws(() => assertSecureSdp(chromeSdp(FP.slice(0, 59), 'sha-1')), /weak/);
  const conflicting = chromeSdp().replace(`a=mid:1`, 'a=mid:1\r\na=fingerprint:sha-256 00:11');
  assert.throws(() => assertSecureSdp(conflicting), /conflicting/);
  assert.throws(() => assertSecureSdp(chromeSdp().replace('UDP/TLS/RTP/SAVPF', 'RTP/AVP')), /unencrypted/);
});
