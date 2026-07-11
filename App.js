import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View, Pressable, useWindowDimensions } from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

// --- Einen kompletten Takt (4 Schläge) als WAV erzeugen ---------------------
// Wird als EINE Datei nahtlos geloopt. Dadurch übernimmt die Audio-Hardware
// das Timing zwischen den Schlägen sample-genau, statt bei jedem Schlag einzeln
// play() mit schwankender Latenz aufzurufen.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
  }
  return out;
}

function writeStr(dv, offset, str) {
  for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
}

function makeBarDataUri(bpm, beats, accents) {
  const rate = 44100;
  const beatSec = 60 / bpm;
  const barSamples = Math.round(rate * beatSec * beats);
  const clickLen = Math.floor(rate * 0.04);
  const pcm = new Int16Array(barSamples); // mit Stille initialisiert

  for (let b = 0; b < beats; b++) {
    const freq = accents.includes(b) ? 1200 : 600;
    const start = Math.round(b * beatSec * rate);
    for (let i = 0; i < clickLen && start + i < barSamples; i++) {
      const env = Math.exp((-i / clickLen) * 7);
      let s =
        (Math.sin((2 * Math.PI * freq * i) / rate) * 0.8 +
          Math.sin((2 * Math.PI * freq * 2 * i) / rate) * 0.2) *
        env;
      s = Math.max(-1, Math.min(1, s * 1.6));
      pcm[start + i] = s * 32767;
    }
  }

  const n = barSamples;
  const bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  writeStr(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + n * 2, true);
  writeStr(dv, 8, 'WAVE');
  writeStr(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  writeStr(dv, 36, 'data');
  dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, pcm[i], true);

  return 'data:audio/wav;base64,' + bytesToBase64(bytes);
}

// Berühmteste Taktarten. accents = Schläge mit hohem Ton (Betonung).
const SIGNATURES = [
  { id: '2/4', beats: 2, accents: [0], name: 'Marsch, Polka' },
  { id: '3/4', beats: 3, accents: [0], name: 'Walzer' },
  { id: '4/4', beats: 4, accents: [0], name: 'Standard (Pop, Rock)' },
  { id: '6/8', beats: 6, accents: [0, 3], name: 'gefühlt in Zweiern' },
];

export default function App() {
  const [bpm, setBpm] = useState(120);
  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState(1);
  const [sigId, setSigId] = useState('4/4');
  const [screen, setScreen] = useState('main'); // 'main' | 'settings'
  const holdRef = useRef(null);

  const signature = SIGNATURES.find((s) => s.id === sigId) || SIGNATURES[2];
  const beatsPerBar = signature.beats;
  const playerRef = useRef(null);
  const dispRef = useRef(null);

  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const change = (delta) => {
    setBpm((prev) => Math.min(300, Math.max(30, prev + delta)));
  };

  const startHold = (delta) => {
    change(delta);
    let count = 0;
    const tick = () => {
      count += 1;
      change(delta);
      // Nach längerem Halten schneller wiederholen
      const delay = count > 15 ? 30 : count > 6 ? 70 : 150;
      holdRef.current = setTimeout(tick, delay);
    };
    holdRef.current = setTimeout(tick, 400);
  };

  const stopHold = () => {
    if (holdRef.current) {
      clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };

  const toggle = () => {
    setRunning((prev) => !prev);
  };

  useEffect(() => () => stopHold(), []);

  // Audio-Modus für möglichst niedrige Latenz / Wiedergabe auch im Stumm-Modus
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    return () => {
      if (playerRef.current) {
        playerRef.current.remove();
        playerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!running) {
      if (playerRef.current) playerRef.current.pause();
      if (dispRef.current) clearInterval(dispRef.current);
      setBeat(1);
      return;
    }

    // Einen ganzen Takt erzeugen und nahtlos loopen lassen.
    const uri = makeBarDataUri(bpm, signature.beats, signature.accents);
    if (!playerRef.current) {
      playerRef.current = createAudioPlayer({ uri });
    } else {
      playerRef.current.replace({ uri });
    }
    const player = playerRef.current;
    player.loop = true;
    player.seekTo(0);
    player.play();

    // Anzeige der aktuellen Zahl aus der echten Wiedergabeposition ableiten.
    const beatSec = 60 / bpm;
    dispRef.current = setInterval(() => {
      const t = player.currentTime || 0;
      const idx = Math.floor(t / beatSec) % beatsPerBar;
      setBeat(idx + 1);
    }, 40);

    return () => {
      if (dispRef.current) {
        clearInterval(dispRef.current);
        dispRef.current = null;
      }
    };
  }, [running, bpm, sigId]);

  if (screen === 'settings') {
    return (
      <View style={styles.settingsScreen}>
        <View style={styles.settingsHeader}>
          <Pressable onPress={() => setScreen('main')} hitSlop={10}>
            <Text style={styles.back}>‹ Zurück</Text>
          </Pressable>
          <Text style={styles.settingsTitle}>Einstellungen</Text>
          <View style={styles.headerSpacer} />
        </View>

        <Text style={styles.settingLabel}>Taktart</Text>
        {SIGNATURES.map((s) => (
          <Pressable
            key={s.id}
            style={[styles.row, sigId === s.id && styles.rowActive]}
            onPress={() => setSigId(s.id)}
          >
            <Text style={[styles.rowId, sigId === s.id && styles.rowTextActive]}>
              {s.id}
            </Text>
            <Text style={[styles.rowName, sigId === s.id && styles.rowTextActive]}>
              {s.name}
            </Text>
            {sigId === s.id && <Text style={styles.check}>✓</Text>}
          </Pressable>
        ))}

        <StatusBar style="auto" />
      </View>
    );
  }

  return (
    <View style={[styles.container, landscape && styles.containerLandscape]}>
      <Pressable style={styles.display} onPress={toggle}>
        <Text style={styles.beat}>{beat}</Text>
        <Text style={styles.hint}>{running ? 'Tippen zum Stoppen' : 'Tippen zum Starten'}</Text>
      </Pressable>

      <View
        style={[
          styles.controls,
          landscape ? styles.controlsLandscape : styles.controlsPortrait,
        ]}
      >
        <Pressable
          style={styles.button}
          onPressIn={() => startHold(landscape ? 1 : -1)}
          onPressOut={stopHold}
        >
          <Text style={styles.buttonText}>{landscape ? '+' : '-'}</Text>
        </Pressable>

        <View style={styles.tempoBox}>
          <Text style={styles.tempo}>{bpm}</Text>
          <Text style={styles.unit}>BPM · {sigId}</Text>
        </View>

        <Pressable
          style={styles.button}
          onPressIn={() => startHold(landscape ? -1 : 1)}
          onPressOut={stopHold}
        >
          <Text style={styles.buttonText}>{landscape ? '-' : '+'}</Text>
        </Pressable>

        <Pressable
          style={styles.settingsButton}
          onPress={() => setScreen('settings')}
          hitSlop={10}
        >
          <Text style={styles.settingsIcon}>⚙</Text>
        </Pressable>
      </View>

      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    flexDirection: 'column',
  },
  containerLandscape: {
    flexDirection: 'row',
  },
  display: {
    flex: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  beat: {
    fontSize: 160,
    fontWeight: 'bold',
  },
  hint: {
    fontSize: 16,
    color: '#888',
    marginTop: 10,
  },
  controls: {
    flex: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsPortrait: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  controlsLandscape: {
    flexDirection: 'column',
    borderLeftWidth: 1,
    borderLeftColor: '#eee',
  },
  button: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#222',
    alignItems: 'center',
    justifyContent: 'center',
    margin: 20,
  },
  buttonText: {
    color: '#fff',
    fontSize: 40,
  },
  tempoBox: {
    alignItems: 'center',
    minWidth: 90,
  },
  tempo: {
    fontSize: 44,
    fontWeight: 'bold',
  },
  unit: {
    fontSize: 16,
    color: '#888',
  },
  settingsButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    padding: 8,
  },
  settingsIcon: {
    fontSize: 26,
    color: '#222',
  },
  // Vollbild-Settings-Seite
  settingsScreen: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 30,
  },
  back: {
    fontSize: 18,
    color: '#222',
  },
  settingsTitle: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  headerSpacer: {
    width: 60,
  },
  settingLabel: {
    fontSize: 15,
    color: '#888',
    marginBottom: 12,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 18,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    marginBottom: 10,
  },
  rowActive: {
    borderColor: '#222',
    backgroundColor: '#222',
  },
  rowId: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#222',
    width: 60,
  },
  rowName: {
    flex: 1,
    fontSize: 15,
    color: '#666',
  },
  rowTextActive: {
    color: '#fff',
  },
  check: {
    fontSize: 20,
    color: '#fff',
    marginLeft: 8,
  },
});
