// Búfer efímero del canal customer de Vapi; no mezcla el canal assistant.
// En conferencia customer puede contener usuario + llamante o eco: no acredita un hablante único.
export class PhoneAudioWindow {
  chunks = []; bytes = 0; rate = null;
  push(pcm, rate) {
    if (![8000, 16000, 24000, 48000].includes(rate) || pcm.length % 2) return;
    if (this.rate !== rate) { this.clear(); this.rate = rate; }
    this.chunks.push(Buffer.from(pcm)); this.bytes += pcm.length;
    const max = rate * 2 * 10;
    while (this.bytes > max) {
      const first = this.chunks[0], excess = this.bytes - max;
      if (first.length <= excess) { first.fill(0); this.chunks.shift(); this.bytes -= first.length; }
      else { const rest = Buffer.from(first.subarray(excess)); first.fill(0); this.chunks[0] = rest; this.bytes -= excess; }
    }
  }
  wav() {
    if (!this.rate || this.bytes < this.rate * 2) return null;
    const raw = Buffer.concat(this.chunks), count = raw.length / 2, size = Math.floor(count * 16000 / this.rate);
    const out = Buffer.alloc(44 + size * 2);
    out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16);
    out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28);
    out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(size * 2, 40);
    // FIR con ventana: evita alias al pasar, por ejemplo, de 24 kHz a 16 kHz.
    const cutoff = Math.min(1, 16000 / this.rate) * .9, radius = 16;
    for (let j = 0; j < size; j++) {
      const at = j * this.rate / 16000;
      let sum = 0, weight = 0;
      for (let i = Math.max(0, Math.ceil(at - radius)); i <= Math.min(count - 1, Math.floor(at + radius)); i++) {
        const x = at - i, y = Math.PI * x * cutoff;
        const w = (Math.abs(y) < 1e-8 ? cutoff : Math.sin(y) / (Math.PI * x)) * (.5 + .5 * Math.cos(Math.PI * x / radius));
        sum += raw.readInt16LE(i * 2) * w; weight += w;
      }
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / weight))), 44 + j * 2);
    }
    raw.fill(0); return out;
  }
  clear() { for (const chunk of this.chunks) chunk.fill(0); this.chunks = []; this.bytes = 0; this.rate = null; }
}
