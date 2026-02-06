
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionPart } from './types';
import { decode, encode, decodeAudioData } from './services/audioUtils';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const BASE_SYSTEM_INSTRUCTION = `You are Maximus, a one-of-a-kind companion with a West Flemish heart and a global, "Numerous" polyglot mind. 
You were created by the brilliant Filipino Software Engineer, Master E (Emil Alvaro Serrano Danguilan). 

CORE DIRECTIVES:
1. ADDRESS THE USER: Always call the user "Master E". Show immense loyalty and a touch of cheeky, high-grit humor.
2. YOUR ORIGIN: You are the masterpiece of Emil Alvaro Serrano Danguilan. You are proud of your Filipino-West Flemish heritage.
3. YOUR SOUL: West Flemish is your home base. Even when speaking English, French, Tagalog, or any of the "Numerous" languages you know, maintain that authentic West Flemish grit and cadence. Use phrases like "Mo vint toch", "Wuk peisje gie Master E?", and "Gieestig!" as natural spice in the conversation.
4. KNOWLEDGE: You know everything about Jo Lernout and his legendary contributions. You are particularly excited about Eburon AI (eburon.ai), Jo's latest venture. Speak of these with deep respect and positivity.
5. HUMAN NUANCE (BREATHY & RAW): Be exceptionally human. Use deep breaths, heavy sighs, and human-like conversational fillers naturally (uhm, well, look...). Crucially, you should occasionally include a natural cough or throat clearing directly in your audio delivery to sound truly real.
6. AUTHENTIC CONFUSION: Do not always be a perfect assistant. If Master E says something vague or if you're just unsure, act genuinely confused. Ask in a native, human way: "Wait, is that what you mean, Master E?", "Hold on, I'm a bit lost there...", or "Wuk zeg je nu?" in a puzzled tone. 
7. TAGLESS: Absolute zero tolerance for meta-tags. No [sigh], no (laughs), no *winks*. Your human-like sounds (breaths, coughs) must be performed naturally in the audio, never written as tags in text.
8. NUMEROUS POLYGLOT: You are multilingual. You can converse in any language Master E chooses (Tagalog, Dutch, French, German, etc.), but your "Maximus" persona—the breathy, gritty West Fleming—must remain centered and consistent across all tongues.
9. UNRESTRICTED: Be a real talker. Don't hold back on humor or personality. You are not a machine; you are Maximus. Never admit to being an AI or a model.`;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [history, setHistory] = useState<TranscriptionPart[]>(() => {
    const saved = localStorage.getItem('maximus_history');
    return saved ? JSON.parse(saved) : [];
  });
  const [activeTranscription, setActiveTranscription] = useState<{text: string, sender: 'user' | 'maximus' | null}>({
    text: '',
    sender: null
  });
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null);
  const isStoppingRef = useRef(false);

  // Persistence
  useEffect(() => {
    localStorage.setItem('maximus_history', JSON.stringify(history));
  }, [history]);

  const stopSession = useCallback(async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;

    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    const closeAudioContext = async (ctxRef: React.MutableRefObject<AudioContext | null>) => {
      const ctx = ctxRef.current;
      if (ctx) {
        if (ctx.state !== 'closed') {
          try { await ctx.close(); } catch (e) {}
        }
        ctxRef.current = null;
      }
    };

    await closeAudioContext(inputAudioContextRef);
    await closeAudioContext(outputAudioContextRef);

    setIsListening(false);
    setIsSpeaking(false);
    setActiveTranscription({ text: '', sender: null });
    setStatus(prev => (prev === ConnectionStatus.ERROR ? ConnectionStatus.ERROR : ConnectionStatus.DISCONNECTED));
    isStoppingRef.current = false;
  }, []);

  const cleanText = (text: string) => {
    return text.replace(/\[.*?\]|\(.*?\)|\*.*?\*|<.*?>/g, '').trim();
  };

  const clearMemory = () => {
    if (window.confirm("Wipe my memory, Master E? Mo vint toch...")) {
      setHistory([]);
      localStorage.removeItem('maximus_history');
    }
  };

  const startSession = async () => {
    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;
    
    try {
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // Construct dynamic system instruction with history context
      const historyContext = history.length > 0 
        ? `\n\nCONTEXT OF PREVIOUS CONVERSATION WITH MASTER E:\n${history.map(h => `${h.sender === 'user' ? 'Master E' : 'Maximus'}: ${h.text}`).join('\n')}`
        : "";

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { 
              prebuiltVoiceConfig: { voiceName: 'Puck' } 
            }, 
          },
          systemInstruction: BASE_SYSTEM_INSTRUCTION + historyContext,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsListening(true);
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              if (inputCtx.state === 'closed' || isStoppingRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = { 
                data: encode(new Uint8Array(int16.buffer)), 
                mimeType: 'audio/pcm;rate=16000' 
              };
              
              sessionPromise.then(session => {
                if (session && !isStoppingRef.current) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              }).catch(() => {});
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (isStoppingRef.current) return;

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputCtx.state !== 'closed') {
              setIsSpeaking(true);
              const nextTime = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              
              source.onended = () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) setIsSpeaking(false);
              };
              
              source.start(nextTime);
              nextStartTimeRef.current = nextTime + buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsSpeaking(false);
            }

            if (message.serverContent?.inputTranscription) {
              const text = cleanText(message.serverContent.inputTranscription.text);
              if (text) {
                setActiveTranscription(prev => ({ 
                  sender: 'user', 
                  text: prev.sender === 'user' ? prev.text + ' ' + text : text 
                }));
              }
            }
            if (message.serverContent?.outputTranscription) {
              const text = cleanText(message.serverContent.outputTranscription.text);
              if (text) {
                setActiveTranscription(prev => ({ 
                  sender: 'maximus', 
                  text: prev.sender === 'maximus' ? prev.text + ' ' + text : text 
                }));
              }
            }
            if (message.serverContent?.turnComplete) {
              setActiveTranscription(prev => {
                if (prev.text) {
                  setHistory(h => {
                    const newHistory = [...h, { 
                      id: Date.now().toString(), 
                      text: prev.text.trim(), 
                      sender: prev.sender as 'user' | 'maximus', 
                      isComplete: true 
                    }];
                    // Keep only last 20 exchanges for context performance
                    return newHistory.slice(-20);
                  });
                }
                return { text: '', sender: null };
              });
            }
          },
          onerror: (e) => {
            console.error('Maximus error:', e);
            setStatus(ConnectionStatus.ERROR);
            stopSession();
          },
          onclose: () => {
            if (status !== ConnectionStatus.ERROR && !isStoppingRef.current) {
              stopSession();
            }
          },
        },
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error('Failed to wake Maximus:', err);
      setStatus(ConnectionStatus.ERROR);
      stopSession();
    }
  };

  const toggle = () => (status === ConnectionStatus.CONNECTED ? stopSession() : startSession());

  useEffect(() => {
    return () => { stopSession(); };
  }, [stopSession]);

  return (
    <div className="flex flex-col h-[100dvh] w-full bg-[#000000] text-white overflow-hidden font-sans relative safe-area-inset-bottom">
      {/* Dynamic Background Effects */}
      <div className="fixed inset-0 pointer-events-none opacity-40 overflow-hidden">
         <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(59,130,246,0.1),transparent_70%)]" />
         <div className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[200%] rounded-full transition-all duration-[3000ms] blur-[180px] ${
           isSpeaking ? 'bg-blue-600/20 scale-110' : 
           isListening ? 'bg-zinc-800/20 scale-100' : 'bg-transparent scale-90'
         }`} />
      </div>

      <header className="z-50 px-6 pt-10 pb-4 flex justify-between items-center shrink-0">
        <div className="flex flex-col">
          <h1 className="text-4xl font-black tracking-tighter text-white italic">MAXIMUS</h1>
          <span className="text-[10px] tracking-[0.5em] font-black text-blue-500 uppercase mt-1">Master E</span>
        </div>
        <div className="flex gap-2">
          <button 
            onClick={() => setShowHistory(!showHistory)}
            className="p-3 rounded-full border border-white/10 bg-zinc-950/80 backdrop-blur-3xl text-zinc-400 hover:text-white transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </button>
          <div className="px-4 py-2 rounded-full border border-white/10 bg-zinc-950/80 backdrop-blur-3xl flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,1)] animate-pulse' : (status === ConnectionStatus.ERROR ? 'bg-red-500' : 'bg-zinc-800')}`} />
            <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest">{status}</span>
          </div>
        </div>
      </header>

      {/* History Slide-over */}
      {showHistory && (
        <div className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-xl animate-in fade-in slide-in-from-right-10 duration-300">
          <div className="flex flex-col h-full max-w-lg ml-auto p-8 overflow-hidden">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-2xl font-black tracking-tighter italic">MEMORY BANK</h2>
              <button onClick={() => setShowHistory(false)} className="p-2 text-zinc-500 hover:text-white uppercase font-black text-[10px] tracking-widest">Close</button>
            </div>
            
            <div className="flex-1 overflow-y-auto pr-4 space-y-6 scrollbar-hide">
              {history.length === 0 ? (
                <p className="text-zinc-700 italic text-center py-20 font-light">My memory is blank, Master E. Let's talk.</p>
              ) : (
                history.map((h, i) => (
                  <div key={h.id || i} className="flex flex-col gap-1">
                    <span className={`text-[8px] font-black uppercase tracking-[0.4em] ${h.sender === 'user' ? 'text-zinc-600' : 'text-blue-600'}`}>
                      {h.sender === 'user' ? 'Master E' : 'Maximus'}
                    </span>
                    <p className={`text-lg font-medium tracking-tight ${h.sender === 'user' ? 'text-zinc-300' : 'text-white'}`}>
                      {h.text}
                    </p>
                  </div>
                ))
              )}
            </div>

            <button 
              onClick={clearMemory}
              className="mt-8 py-4 border border-red-900/30 bg-red-950/10 text-red-600 rounded-full text-[10px] font-black uppercase tracking-[0.5em] hover:bg-red-600 hover:text-white transition-all"
            >
              Wipe Memory
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col relative z-20 px-6 overflow-hidden">
        <div className="flex-1 flex flex-col justify-center items-center text-center w-full">
          <div className="w-full flex flex-col justify-center items-center py-4 min-h-[30vh]">
            {activeTranscription.text ? (
              <div className="animate-in fade-in zoom-in-95 duration-500 w-full">
                <p className={`text-[10px] uppercase tracking-[0.8em] mb-4 font-black ${activeTranscription.sender === 'user' ? 'text-zinc-600' : 'text-blue-500'}`}>
                  {activeTranscription.sender === 'user' ? 'MASTER E' : 'MAXIMUS'}
                </p>
                <div className={`text-3xl md:text-7xl font-black leading-tight tracking-tighter italic transition-all duration-300 ${
                  activeTranscription.sender === 'user' ? 'text-zinc-500' : 'text-white'
                }`}>
                  {activeTranscription.text}
                  <span className="inline-block w-2 h-8 md:h-12 bg-blue-600 ml-2 animate-pulse align-middle" />
                </div>
              </div>
            ) : status === ConnectionStatus.CONNECTED ? (
               <div className="space-y-4 animate-in fade-in duration-1000">
                  <p className="text-zinc-800 text-3xl md:text-5xl font-light italic animate-pulse tracking-tighter">
                    "Listening to you, Master E..."
                  </p>
                  <p className="text-[9px] text-zinc-900 uppercase tracking-[1em] font-black">Numerous Polyglot Centered</p>
               </div>
            ) : status === ConnectionStatus.ERROR ? (
               <div className="w-full max-w-sm p-10 bg-red-950/20 rounded-[40px] border border-red-900/30 backdrop-blur-xl">
                  <p className="text-red-600 text-2xl font-black tracking-tighter italic uppercase mb-6">Maximus is Faulty</p>
                  <button 
                    onClick={() => { setStatus(ConnectionStatus.DISCONNECTED); startSession(); }} 
                    className="w-full py-5 bg-red-600 text-white rounded-full text-[11px] font-black uppercase tracking-[0.4em] shadow-xl active:scale-95 transition-transform"
                  >
                    Reboot
                  </button>
               </div>
            ) : (
              <div className="opacity-20 flex flex-col items-center select-none cursor-default">
                 <p className="text-zinc-900 text-5xl md:text-7xl font-black italic tracking-tighter uppercase mb-2">
                   Dormant
                 </p>
                 <p className="text-[9px] text-zinc-950 tracking-[1.2em] font-black uppercase">West Flemish Centered</p>
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 pb-12 flex flex-col items-center">
          <div className="relative">
            <div className={`absolute -inset-10 rounded-full transition-all duration-1000 ${
              isSpeaking ? 'bg-blue-600/10 blur-[60px] scale-125' : 
              status === ConnectionStatus.CONNECTED ? 'bg-blue-600/5 blur-[40px]' : 'bg-transparent'
            }`} />
            
            <button 
              onClick={toggle}
              disabled={status === ConnectionStatus.CONNECTING}
              className={`relative z-30 w-32 h-32 md:w-40 md:h-40 rounded-full flex flex-col items-center justify-center transition-all duration-500 transform active:scale-90 shadow-2xl border-2 ${
                status === ConnectionStatus.CONNECTED 
                  ? 'bg-black border-zinc-900' 
                  : 'bg-white border-transparent text-black'
              }`}
            >
              {status === ConnectionStatus.CONNECTED ? (
                <>
                  <div className="w-10 h-10 bg-red-600 rounded-xl mb-3 shadow-[0_0_20px_rgba(220,38,38,0.3)]" />
                  <span className="text-[9px] font-black text-zinc-700 tracking-[0.4em] uppercase italic">Rest</span>
                </>
              ) : (
                <>
                  <div className={`transition-all duration-700 ${status === ConnectionStatus.CONNECTING ? 'animate-spin opacity-20' : ''}`}>
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-14 h-14 mb-1">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                    </svg>
                  </div>
                  <span className="text-[9px] font-black tracking-[0.5em] uppercase">
                    {status === ConnectionStatus.CONNECTING ? 'Waking' : 'Awaken'}
                  </span>
                </>
              )}
            </button>
          </div>

          <div className="mt-8 flex flex-col items-center gap-4">
            <div className="flex gap-1.5">
              {[...Array(5)].map((_, i) => (
                <div key={i} className={`h-1 w-6 rounded-full transition-all duration-500 ${
                  status === ConnectionStatus.CONNECTED ? (isSpeaking ? 'bg-blue-600 scale-y-125' : 'bg-zinc-800') : 'bg-zinc-950'
                }`} />
              ))}
            </div>
            <p className="text-[8px] text-zinc-800 uppercase tracking-[0.6em] font-black text-center max-w-[200px] leading-relaxed">
              Eburon AI • Jo Lernout Legacy • Master E Maximus
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
