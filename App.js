import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  Pressable,
  useWindowDimensions,
  useColorScheme,
  ScrollView,
} from 'react-native';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { File, Paths } from 'expo-file-system';

const STORAGE_KEY = 'metronome:settings';

// --- Einen kompletten Takt (4 Schläge) als WAV erzeugen ---------------------
// Wird als EINE Datei nahtlos geloopt. Dadurch übernimmt die Audio-Hardware
// das Timing zwischen den Schlägen sample-genau, statt bei jedem Schlag einzeln
// play() mit schwankender Latenz aufzurufen.
function writeStr(dv, offset, str) {
  for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
}

function makeBarBytes(bpm, beats, accents) {
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
  return bytes;
}

// Takt als echte Datei ablegen und deren URI zurückgeben. iOS loopt Dateien
// lückenlos – eine data:-URI wird am Loop-Ende neu dekodiert und erzeugt eine
// hörbare Pause vor Takt 1.
function writeBarFile(bpm, beats, accents) {
  const bytes = makeBarBytes(bpm, beats, accents);
  const name = `bar_${bpm}_${beats}_${accents.join('-')}.wav`;
  const file = new File(Paths.cache, name);
  try {
    if (file.exists) file.delete();
  } catch (e) {
    // ignorieren – wird gleich neu geschrieben
  }
  file.create();
  file.write(bytes);
  return file.uri;
}

const THEMES = {
  light: {
    bg: '#fff',
    text: '#222',
    sub: '#888',
    border: '#eee',
    fg: '#222', // Buttons / aktive Flächen
    fgText: '#fff', // Text auf fg
  },
  dark: {
    bg: '#111',
    text: '#f2f2f2',
    sub: '#888',
    border: '#333',
    fg: '#f2f2f2',
    fgText: '#111',
  },
};

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
  const [themePref, setThemePref] = useState('system'); // 'system' | 'light' | 'dark'
  const [displayMode, setDisplayMode] = useState('numbers'); // 'numbers' | 'dots'
  const [openSection, setOpenSection] = useState('sig'); // welche Kategorie aufgeklappt ist
  const holdRef = useRef(null);

  const systemScheme = useColorScheme();
  const effectiveTheme =
    themePref === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : themePref;
  const c = THEMES[effectiveTheme];

  const signature = SIGNATURES.find((s) => s.id === sigId) || SIGNATURES[2];
  const beatsPerBar = signature.beats;
  const playerRef = useRef(null);
  const dispRef = useRef(null);
  const tapTimesRef = useRef([]);
  const loadedRef = useRef(false);

  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  // Gespeicherte Einstellungen beim Start laden.
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          if (typeof s.bpm === 'number') setBpm(s.bpm);
          if (typeof s.sigId === 'string') setSigId(s.sigId);
          if (typeof s.themePref === 'string') setThemePref(s.themePref);
          if (typeof s.displayMode === 'string') setDisplayMode(s.displayMode);
        }
      } catch (e) {
        // Einstellungen konnten nicht geladen werden – Standardwerte verwenden.
      } finally {
        loadedRef.current = true;
      }
    })();
  }, []);

  // Änderungen speichern (erst nach dem initialen Laden).
  useEffect(() => {
    if (!loadedRef.current) return;
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ bpm, sigId, themePref, displayMode })
    ).catch(() => {});
  }, [bpm, sigId, themePref, displayMode]);

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

  // Tap-Tempo: BPM aus dem Rhythmus der Taps ableiten.
  const RESET_GAP = 2000; // ms: längere Pause startet eine neue Tap-Sequenz
  const MIN_TAPS = 4; // erst nach so vielen Taps wird das Tempo übernommen
  const MAX_TAPS = 8; // gleitender Mittelwert über die letzten Taps
  const [tapCount, setTapCount] = useState(0);
  const tapTempo = () => {
    const now = performance.now();
    let times = tapTimesRef.current;
    if (times.length && now - times[times.length - 1] > RESET_GAP) {
      times = []; // Sequenz zurücksetzen
    }
    times.push(now);
    if (times.length > MAX_TAPS) times = times.slice(-MAX_TAPS);
    tapTimesRef.current = times;
    setTapCount(times.length);

    // Erst ab MIN_TAPS Taps übernehmen – so hat man Zeit, sich einzupendeln.
    if (times.length >= MIN_TAPS) {
      // Durchschnitt aller Intervalle im Fenster = stabiler als der letzte Wert
      const span = times[times.length - 1] - times[0];
      const avgInterval = span / (times.length - 1);
      const next = Math.round(60000 / avgInterval);
      setBpm(Math.min(300, Math.max(30, next)));
    }
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

    // Einen ganzen Takt als Datei erzeugen und nahtlos loopen lassen.
    const uri = writeBarFile(bpm, signature.beats, signature.accents);
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
    const toggleSection = (key) =>
      setOpenSection((cur) => (cur === key ? null : key));

    const themeLabels = { system: 'System', light: 'Hell', dark: 'Dunkel' };
    const displayLabels = { numbers: 'Zahlen', dots: 'Punkte' };

    const SectionHeader = ({ id, title, value }) => (
      <Pressable
        style={[styles.sectionHeader, { borderColor: c.border }]}
        onPress={() => toggleSection(id)}
      >
        <Text style={[styles.sectionTitle, { color: c.text }]}>{title}</Text>
        <View style={styles.sectionRight}>
          <Text style={[styles.sectionValue, { color: c.sub }]}>{value}</Text>
          <Text style={[styles.chevron, { color: c.sub }]}>
            {openSection === id ? '▾' : '▸'}
          </Text>
        </View>
      </Pressable>
    );

    const OptionRow = ({ active, onPress, children }) => (
      <Pressable
        style={[
          styles.row,
          { borderColor: c.border },
          active && { borderColor: c.fg, backgroundColor: c.fg },
        ]}
        onPress={onPress}
      >
        {children}
        {active && <Text style={[styles.check, { color: c.fgText }]}>✓</Text>}
      </Pressable>
    );

    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <ScrollView contentContainerStyle={styles.settingsContent}>
          <View style={styles.settingsHeader}>
            <Pressable onPress={() => setScreen('main')} hitSlop={10}>
              <Text style={[styles.back, { color: c.text }]}>‹ Zurück</Text>
            </Pressable>
            <Text style={[styles.settingsTitle, { color: c.text }]}>Einstellungen</Text>
            <View style={styles.headerSpacer} />
          </View>

          <SectionHeader id="sig" title="Taktart" value={sigId} />
          {openSection === 'sig' && (
            <View style={styles.sectionBody}>
              {SIGNATURES.map((s) => {
                const active = sigId === s.id;
                return (
                  <OptionRow key={s.id} active={active} onPress={() => setSigId(s.id)}>
                    <Text style={[styles.rowId, { color: active ? c.fgText : c.text }]}>
                      {s.id}
                    </Text>
                    <Text style={[styles.rowName, { color: active ? c.fgText : c.sub }]}>
                      {s.name}
                    </Text>
                  </OptionRow>
                );
              })}
            </View>
          )}

          <SectionHeader
            id="theme"
            title="Darstellung"
            value={themeLabels[themePref]}
          />
          {openSection === 'theme' && (
            <View style={styles.sectionBody}>
              {['system', 'light', 'dark'].map((t) => {
                const active = themePref === t;
                return (
                  <OptionRow key={t} active={active} onPress={() => setThemePref(t)}>
                    <Text style={[styles.rowName, { color: active ? c.fgText : c.text }]}>
                      {themeLabels[t]}
                    </Text>
                  </OptionRow>
                );
              })}
            </View>
          )}

          <SectionHeader
            id="display"
            title="Anzeige"
            value={displayLabels[displayMode]}
          />
          {openSection === 'display' && (
            <View style={styles.sectionBody}>
              {['numbers', 'dots'].map((d) => {
                const active = displayMode === d;
                return (
                  <OptionRow key={d} active={active} onPress={() => setDisplayMode(d)}>
                    <Text style={[styles.rowName, { color: active ? c.fgText : c.text }]}>
                      {displayLabels[d]}
                    </Text>
                  </OptionRow>
                );
              })}
            </View>
          )}
        </ScrollView>

        <StatusBar style={effectiveTheme === 'dark' ? 'light' : 'dark'} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        landscape && styles.containerLandscape,
        { backgroundColor: c.bg },
      ]}
    >
      <Pressable style={styles.display} onPress={toggle}>
        {displayMode === 'dots' ? (
          <View style={styles.dotsRow}>
            {Array.from({ length: beatsPerBar }).map((_, i) => {
              const filled = running && i < beat;
              const isAccent = signature.accents.includes(i);
              return (
                <View
                  key={i}
                  style={[
                    styles.dot,
                    isAccent && styles.dotAccent,
                    { borderColor: c.text },
                    filled && { backgroundColor: c.text },
                  ]}
                />
              );
            })}
          </View>
        ) : (
          <Text style={[styles.beat, { color: c.text }]}>{beat}</Text>
        )}
        <Text style={[styles.hint, { color: c.sub }]}>
          {running ? 'Tippen zum Stoppen' : 'Tippen zum Starten'}
        </Text>
      </Pressable>

      <View
        style={[
          styles.controls,
          landscape ? styles.controlsLandscape : styles.controlsPortrait,
          landscape ? { borderLeftColor: c.border } : { borderTopColor: c.border },
        ]}
      >
        <Pressable
          style={[styles.button, { backgroundColor: c.fg }]}
          onPressIn={() => startHold(landscape ? 1 : -1)}
          onPressOut={stopHold}
        >
          <Text style={[styles.buttonText, { color: c.fgText }]}>
            {landscape ? '+' : '-'}
          </Text>
        </Pressable>

        <View style={styles.tempoBox}>
          <Text style={[styles.tempo, { color: c.text }]}>{bpm}</Text>
          <Text style={[styles.unit, { color: c.sub }]}>BPM · {sigId}</Text>
          <Pressable
            style={[styles.tapButton, { borderColor: c.fg }]}
            onPress={tapTempo}
            hitSlop={8}
          >
            <Text style={[styles.tapButtonText, { color: c.text }]}>
              {tapCount > 0 && tapCount < MIN_TAPS ? `${tapCount}/${MIN_TAPS}` : 'TAP'}
            </Text>
          </Pressable>
        </View>

        <Pressable
          style={[styles.button, { backgroundColor: c.fg }]}
          onPressIn={() => startHold(landscape ? -1 : 1)}
          onPressOut={stopHold}
        >
          <Text style={[styles.buttonText, { color: c.fgText }]}>
            {landscape ? '-' : '+'}
          </Text>
        </Pressable>

        <Pressable
          style={styles.settingsButton}
          onPress={() => setScreen('settings')}
          hitSlop={10}
        >
          <Text style={[styles.settingsIcon, { color: c.text }]}>⚙</Text>
        </Pressable>
      </View>

      <StatusBar style={effectiveTheme === 'dark' ? 'light' : 'dark'} />
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
  dotsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    maxWidth: 300,
    gap: 16,
  },
  dot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
  },
  dotAccent: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 3,
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
  tapButton: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 22,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  tapButtonText: {
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 1,
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
  settingsContent: {
    paddingTop: 60,
    paddingHorizontal: 20,
    paddingBottom: 40,
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 18,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  sectionRight: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  sectionValue: {
    fontSize: 15,
    marginRight: 10,
  },
  chevron: {
    fontSize: 14,
    width: 16,
    textAlign: 'center',
  },
  sectionBody: {
    marginBottom: 10,
    paddingLeft: 8,
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
