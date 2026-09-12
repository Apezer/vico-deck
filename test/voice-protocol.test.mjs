import assert from "node:assert/strict";
import { VOICE_PACKET, VoiceTransferReceiver, buildVoicePacket, encodePcm16Wav, voiceCrc32 } from "../src/voice-protocol.js";

const uint32 = value => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const pcm = Uint8Array.from({ length:128 }, (_, index) => index);
const crc = voiceCrc32(pcm);
const events = [];
const receiver = new VoiceTransferReceiver(event => events.push(event));

receiver.accept(buildVoicePacket(VOICE_PACKET.RECORDING_STARTED, 7, [0x80, 0x3e, 20, 0]));
for (let offset = 0; offset < 69; offset += 23) {
  receiver.accept(buildVoicePacket(VOICE_PACKET.AUDIO_CHUNK, 7, [...uint32(offset), ...pcm.slice(offset, offset + 23)]));
}
receiver.accept(buildVoicePacket(VOICE_PACKET.RECORDING_STOPPED, 7, [...uint32(pcm.length), ...uint32(crc), 0x80, 0x3e]));
for (let offset = 69; offset < pcm.length; offset += 23) {
  receiver.accept(buildVoicePacket(VOICE_PACKET.AUDIO_CHUNK, 7, [...uint32(offset), ...pcm.slice(offset, offset + 23)]));
}
receiver.accept(buildVoicePacket(VOICE_PACKET.TRANSFER_END, 7, [...uint32(pcm.length), ...uint32(crc)]));

assert.equal(events[0].type, "recording");
assert.equal(events.at(-1).type, "complete");
assert.equal(events.at(-1).sampleRate, 16000);
assert.deepEqual(events.at(-1).wavBytes.slice(44), pcm);
assert.equal(new TextDecoder().decode(events.at(-1).wavBytes.slice(0, 4)), "RIFF");
assert.equal(encodePcm16Wav(pcm, 16000).length, 172);

const errors = [];
const broken = new VoiceTransferReceiver(event => errors.push(event));
broken.accept(buildVoicePacket(VOICE_PACKET.RECORDING_STARTED, 3, [0x80, 0x3e, 20, 0]));
broken.accept(buildVoicePacket(VOICE_PACKET.AUDIO_CHUNK, 3, [...uint32(2), 1, 2]));
assert.equal(errors.at(-1).type, "error");

console.log("Voice protocol passed: recording, chunks, CRC32 and WAV encoding");
