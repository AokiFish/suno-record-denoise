"""Build the v2 real-song eval fixture (deterministic, sample-exact).

Source: Beethoven Moonlight Sonata 1st movement, piano performance by
elduendesuarez, Wikimedia Commons, CC BY-SA 4.0:
https://commons.wikimedia.org/wiki/File:Beethoven_-_Moonlight_Sonata_Op-27_No-2_(Piano_Performance_by_eld%C3%BCendes%C3%BCarez).wav

Layout (42.0 s, 44.1 kHz stereo, s16le):
  [0-1 s]   pure pink noise (the sn sample segment)
  [1-21 s]  song + pink noise at -20 dB SNR
  [21-22 s] digital silence (silence metric)
  [22-42 s] song + pink noise at -20 dB SNR
clean42.wav is the same layout with the song only (1 s silence head instead
of the noise head, same 1 s silence gap).

Song excerpt: 10-50 s of the recording, attenuated 1 dB for mix headroom.
Pink noise: FFT 1/f shaped white noise, seed 20261116, independent per channel,
scaled so noise RMS = song RMS * 10^(-20/20).
"""
import sys
import numpy as np
from scipy.io import wavfile

SR = 44100
FIXDIR = __file__.rsplit("/", 2)[0] + "/fixtures"


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))


def db(x: float) -> float:
    return 20 * np.log10(max(x, 1e-12))


def pink_noise(n: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n)
    freqs[0] = freqs[1]
    spec = spec / np.sqrt(freqs)
    out = np.fft.irfft(spec, n)
    return out / rms(out)


def main() -> None:
    sr, data = wavfile.read(f"{FIXDIR}/moonlight.wav")
    assert sr == SR, sr
    song = data.astype(np.float64) / 32768.0  # (N, 2)
    song = song[10 * SR:50 * SR]  # 40 s excerpt
    assert song.shape == (40 * SR, 2), song.shape
    song = song * 10 ** (-1.0 / 20)  # -1 dB headroom for the mix
    song_rms = rms(song)
    print(f"song excerpt RMS: {db(song_rms):.2f} dBFS  peak: {db(np.max(np.abs(song))):.2f} dBFS")

    noise = np.stack(
        [pink_noise(42 * SR, 20261116), pink_noise(42 * SR, 20261117)], axis=1
    )
    target_rms = song_rms * 10 ** (-20.0 / 20)
    noise = noise * (target_rms / rms(noise))
    print(f"pink noise RMS: {db(rms(noise)):.2f} dBFS  (target {db(target_rms):.2f})")
    print(f"SNR: {db(song_rms) - db(rms(noise)):.2f} dB")

    mixed = song + noise[2 * SR:42 * SR]  # 40 s of noise under the song
    peak = np.max(np.abs(mixed))
    print(f"mixed peak: {db(peak):.2f} dBFS")
    assert peak < 0.999, f"mixed clips: peak {peak}"

    fixture = np.concatenate(
        [noise[0:1 * SR], mixed[0:20 * SR], np.zeros((1 * SR, 2)), mixed[20 * SR:40 * SR]]
    )
    clean = np.concatenate(
        [np.zeros((1 * SR, 2)), song[0:20 * SR], np.zeros((1 * SR, 2)), song[20 * SR:40 * SR]]
    )
    assert fixture.shape == (42 * SR, 2), fixture.shape
    assert clean.shape == (42 * SR, 2), clean.shape

    def write_wav(path: str, x: np.ndarray) -> None:
        q = np.clip(np.round(x * 32767), -32768, 32767).astype(np.int16)
        wavfile.write(path, SR, q)

    write_wav(f"{FIXDIR}/fixture42.wav", fixture)
    write_wav(f"{FIXDIR}/clean42.wav", clean)

    print("--- fixture42 segment check ---")
    for label, a, b in [
        ("head 0-1s pure noise", 0, 1),
        ("music 5-6s", 5, 6),
        ("gap 21-22s", 21, 22),
        ("music 30-31s", 30, 31),
    ]:
        seg = fixture[a * SR:b * SR]
        print(f"{label}: RMS {db(rms(seg)):.2f} dBFS  peak {db(np.max(np.abs(seg))):.2f} dBFS")
    gap = fixture[21 * SR:22 * SR]
    assert np.max(np.abs(gap)) == 0, "gap is not digital silence"
    print("gap is exact digital silence: OK")


if __name__ == "__main__":
    sys.exit(main())
