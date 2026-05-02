import React, { useState, useRef, useEffect } from 'react';
import * as faceapi from '@vladmandic/face-api';
import { Camera, Upload, RefreshCw, Check, Download, Search, Loader2, Image as ImageIcon, ChevronRight, AlertCircle, Play, ArrowLeft, RefreshCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import JSZip from 'jszip';

// Config
const MATCH_THRESHOLD = 0.54; // Balanced threshold for high accuracy (0.50 - 0.55 is sweet spot)
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';

interface DriveFile {
  id: string;
  url: string;
  thumb: string;
  downloadUrl: string;
  name: string;
  isVideo?: boolean;
  dist?: number;
  timestamp?: number;
  folderName?: string;
}

type Step = 'capture' | 'scanning' | 'results';

export default function App() {
  const [step, setStep] = useState<Step>('capture');
  const [referencePhotos, setReferencePhotos] = useState<string[]>([]);
  const [driveLink, setDriveLink] = useState('');
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isModelsLoaded, setIsModelsLoaded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [stats, setStats] = useState({ total: 0, scanned: 0, matches: 0 });
  const [matches, setMatches] = useState<DriveFile[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Filters State
  const [filterType, setFilterType] = useState<'all' | 'photo' | 'video'>('all');
  const [minConfidence, setMinConfidence] = useState(0); // 0-100%
  const [dateRange, setDateRange] = useState<[number, number] | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const referenceDescriptors = useRef<Float32Array[]>([]);

  // Derived filtered matches
  const filteredMatches = matches.filter(m => {
    const confidence = Math.round((1 - (m.dist || 0)) * 100);
    const passType = filterType === 'all' || (filterType === 'photo' && !m.isVideo) || (filterType === 'video' && m.isVideo);
    const passConfidence = confidence >= minConfidence;
    const passDate = !dateRange || (m.timestamp && m.timestamp >= dateRange[0] && m.timestamp <= dateRange[1]);
    const passFolder = selectedFolder === 'all' || m.folderName === selectedFolder;
    return passType && passConfidence && passDate && passFolder;
  });

  // Extract unique folders for filter
  const uniqueFolders = Array.from(new Set(matches.map(m => m.folderName).filter(Boolean))) as string[];

  // Load Models
  useEffect(() => {
    async function loadModels() {
      try {
        await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        setIsModelsLoaded(true);
      } catch (err) {
        console.error('Error loading models:', err);
        setError('Failed to load face recognition models.');
      }
    }
    loadModels();
  }, []);

  // Camera Management
  const [stream, setStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    if (isCameraActive && videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [isCameraActive, stream]);

  // Automatically stop camera when leaving capture step
  useEffect(() => {
    if (step !== 'capture' && stream) {
      stopCamera();
    }
  }, [step, stream]);

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [stream]);

  const resetApp = () => {
    setReferencePhotos([]);
    setMatches([]);
    setStats({ total: 0, scanned: 0, matches: 0 });
    setProgress(0);
    setStatus('');
    setStep('capture');
    setIsCameraActive(false);
    setSelectedIds(new Set());
    setError(null);
  };

  const startCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280, height: 720 } });
      setStream(mediaStream);
      setIsCameraActive(true);
      setError(null);
    } catch (err: any) {
      console.error('Camera error:', err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setError('Camera access denied. Please enable camera permissions in your browser settings.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setError('Camera hardware not found. Please ensure your camera is connected.');
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        setError('Camera is already in use by another application.');
      } else {
        setError('Could not access camera. Please check your device and try again.');
      }
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
      setIsCameraActive(false);
    }
  };

  const extractFolderId = (url: string): string | null => {
    try {
      if (!url || !url.trim()) return null;
      // Handle /folders/ID
      const folderMatch = url.match(/\/folders\/([a-zA-Z0-9_-]{25,50})/);
      if (folderMatch) return folderMatch[1];

      // Handle id=ID (embedded view)
      const idMatch = url.match(/id=([a-zA-Z0-9_-]{25,50})/);
      if (idMatch) return idMatch[1];

      // If it looks like just an ID, return it
      if (/^[a-zA-Z0-9_-]{25,50}$/.test(url.trim())) return url.trim();

      return null;
    } catch {
      return null;
    }
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        setReferencePhotos(prev => [...prev, dataUrl]);
        // Don't stop camera yet, maybe they want more angles
      }
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      Array.from(files).forEach((file: File) => {
        const reader = new FileReader();
        reader.onload = (ev) => setReferencePhotos(prev => [...prev, ev.target?.result as string]);
        reader.readAsDataURL(file);
      });
    }
  };

  // Helper to extract and scan frames from video
  const scanVideoFile = async (file: DriveFile, statusUpdate: (s: string) => void): Promise<number | null> => {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.src = file.url; // Use original proxy URL for video
      video.muted = true;
      video.playsInline = true;

      const detectionOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }); // Lower for video frames, but not too low to prevent false positives
      let bestMatchDist = Infinity;

      video.onloadedmetadata = async () => {
        const duration = video.duration;
        // High-density sampling: Start, End, and dynamic points
        const frameTimes = [0.2, duration * 0.1, duration * 0.3, duration * 0.5, duration * 0.7, duration * 0.9, duration - 0.2];

        // Add more samples for longer videos (every 2 seconds)
        if (duration > 10) {
          for (let t = 2; t < duration; t += 2.5) {
            if (!frameTimes.some(pt => Math.abs(pt - t) < 0.5)) frameTimes.push(t);
          }
        }

        const uniqueTimes = Array.from(new Set(frameTimes))
          .filter(t => t >= 0 && t <= duration)
          .sort((a, b) => a - b)
          .slice(0, 15); // Max 15 frames for performance but high accuracy

        for (let i = 0; i < uniqueTimes.length; i++) {
          const time = uniqueTimes[i];
          video.currentTime = time;
          statusUpdate(`Analyzing video frame ${i + 1}/${uniqueTimes.length} (${Math.round(time)}s)...`);

          await new Promise(r => {
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              r(null);
            };
            video.addEventListener('seeked', onSeeked);
            setTimeout(onSeeked, 3000); // 3s timeout per frame
          });

          const canvas = document.createElement('canvas');
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0);
            const detections = await faceapi.detectAllFaces(canvas, detectionOptions).withFaceLandmarks().withFaceDescriptors();

            for (const det of detections) {
              for (const refDesc of referenceDescriptors.current) {
                const dist = faceapi.euclideanDistance(refDesc, det.descriptor);
                if (dist < MATCH_THRESHOLD) {
                  resolve(dist);
                  return;
                }
                if (dist < bestMatchDist) bestMatchDist = dist;
              }
            }
          }
        }
        resolve(bestMatchDist < Infinity ? bestMatchDist : null);
      };

      video.onerror = (e) => {
        console.error('Video load error', e);
        resolve(null);
      };

      setTimeout(() => resolve(null), 120000); // 2min max for video
    });
  };

  // Main Scanning Logic
  const startScan = async () => {
    if (referencePhotos.length === 0) return;

    const currentFolderId = extractFolderId(driveLink);
    if (!currentFolderId) {
      setError('Please paste a valid Google Drive folder link before scanning.');
      return;
    }

    stopCamera();
    setStep('scanning');
    setProgress(5);
    setStatus('Building face identity profile...');

    try {
      // 1. Get Reference Descriptors from all photos
      referenceDescriptors.current = [];
      const failedPhotos: number[] = [];

      for (let i = 0; i < referencePhotos.length; i++) {
        const photo = referencePhotos[i];
        setStatus(`Analyzing reference angle ${i + 1}/${referencePhotos.length}...`);
        const img = await faceapi.fetchImage(photo);

        // Strict detection for reference to ensure we only get the main face, not blurry background friends
        const detections = await faceapi.detectAllFaces(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.3 }))
          .withFaceLandmarks()
          .withFaceDescriptors();

        if (detections.length > 0) {
          // Take the largest face if multiple detected in reference
          const largest = detections.reduce((acc, curr) => (curr.detection.box.area > acc.detection.box.area ? curr : acc));
          referenceDescriptors.current.push(largest.descriptor);
        } else {
          failedPhotos.push(i + 1);
        }
      }

      if (failedPhotos.length > 0 && referenceDescriptors.current.length === 0) {
        setError(`No faces detected in any of your photos. Please ensure your face is clearly visible and well-lit.`);
        setStep('capture');
        return;
      }

      if (failedPhotos.length > 0) {
        setStatus(`Note: Faces not found in ${failedPhotos.length} angle(s). Proceeding with ${referenceDescriptors.current.length} valid profiles...`);
        await new Promise(r => setTimeout(r, 2000));
      }

      // 2. Fetch Drive Files via Proxy (Multi-pass to ensure all photos load from lazy-loading Drive)
      setProgress(15);
      setStatus('Connecting to Event Vault...');
      let files: DriveFile[] = [];
      const seenIds = new Set<string>();

      // Fetch Drive Files via Proxy
      setStatus('Discovering items... (This may take a minute)');
      try {
        const driveRes = await fetch(`/api/drive-folder/${currentFolderId}?t=${Date.now()}`);
        if (driveRes.ok) {
          const driveData = await driveRes.json();
          if (driveData.files) {
            driveData.files.forEach((f: DriveFile) => {
              if (!seenIds.has(f.id)) {
                seenIds.add(f.id);
                files.push(f);
              }
            });
          }
        }
      } catch (err: any) {
        console.warn(`Discovery failed:`, err.message);
      }

      // Update stats
      setStats(prev => ({ ...prev, total: files.length }));
      setProgress(25);

      if (files.length > 0 && files.length < 200) {
        setStatus(`Note: Folder may be limited. Use GOOGLE_DRIVE_API_KEY for full folder access.`);
        await new Promise(r => setTimeout(r, 2500));
      }

      if (files.length === 0) {
        setStatus('No files found in event folder after multiple attempts.');
        setStep('results');
        return;
      }

      setStats({ total: files.length, scanned: 0, matches: 0 });

      // Detection options for scanning (balanced for groups but strict enough to avoid noise)
      const detectionOptions = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.2 });

      // 3. Process Files
      const foundMatches: DriveFile[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setStatus(`Searching ${file.isVideo ? 'video' : 'photo'} ${i + 1}...`);
        setProgress(15 + ((i + 1) / files.length) * 80);

        try {
          let bestDistFound: number | null = null;

          if (file.isVideo) {
            // Check thumbnail first (quick win)
            const fileImg = await faceapi.fetchImage(file.thumb);
            const detections = await faceapi.detectAllFaces(fileImg, detectionOptions).withFaceLandmarks().withFaceDescriptors();

            for (const det of detections) {
              for (const refDesc of referenceDescriptors.current) {
                const dist = faceapi.euclideanDistance(refDesc, det.descriptor);
                if (dist < MATCH_THRESHOLD) {
                  bestDistFound = dist;
                  break;
                }
              }
              if (bestDistFound !== null) break;
            }

            // If no match in thumbnail, do deep scan of frames
            if (bestDistFound === null) {
              bestDistFound = await scanVideoFile(file, (s) => setStatus(`Deep Scanning Video: ${s}`));
            }
          } else {
            const fileImg = await faceapi.fetchImage(file.thumb);
            const detections = await faceapi.detectAllFaces(fileImg, detectionOptions).withFaceLandmarks().withFaceDescriptors();

            for (const det of detections) {
              for (const refDesc of referenceDescriptors.current) {
                const dist = faceapi.euclideanDistance(refDesc, det.descriptor);
                if (bestDistFound === null || dist < bestDistFound) {
                  bestDistFound = dist;
                }
                if (dist < MATCH_THRESHOLD) {
                  break; // found good enough match for this file
                }
              }
              if (bestDistFound !== null && bestDistFound < MATCH_THRESHOLD) break;
            }
          }

          if (bestDistFound !== null && bestDistFound < MATCH_THRESHOLD) {
            foundMatches.push({ ...file, dist: bestDistFound });
            setStats(prev => ({ ...prev, matches: foundMatches.length }));
          }
        } catch (e) {
          console.warn(`Could not process file ${file.id}`);
        }
        setStats(prev => ({ ...prev, scanned: i + 1 }));
      }

      setMatches(foundMatches.sort((a, b) => (a.dist || 0) - (b.dist || 0)));
      setSelectedIds(new Set(foundMatches.map(m => m.id)));
      setStep('results');
    } catch (err) {
      console.error(err);
      setError('An error occurred during scanning.');
      setStep('capture');
    }
  };

  const downloadOne = async (e: React.MouseEvent, file: DriveFile) => {
    e.stopPropagation();
    try {
      const response = await fetch(file.downloadUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const ext = file.isVideo ? 'mp4' : 'jpg';
      link.download = `moment_${file.id}.${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      window.open(file.downloadUrl, '_blank');
    }
  };

  const downloadAll = async () => {
    const zip = new JSZip();
    const folder = zip.folder("Cipla_Event_Moments");

    const selectedFiles = filteredMatches.filter(m => selectedIds.has(m.id));
    if (selectedFiles.length === 0) return;

    setStatus(`Preparing ${selectedFiles.length} files...`);
    setStep('scanning'); // Show progress for zip generation
    setProgress(10);

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      try {
        const response = await fetch(file.downloadUrl);
        const blob = await response.blob();
        const ext = file.isVideo ? 'mp4' : 'jpg';
        folder?.file(`moment_${i + 1}.${ext}`, blob);
        setProgress(10 + (i / selectedFiles.length) * 80);
      } catch (e) {
        console.error(e);
      }
    }

    setProgress(95);
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(content);
    link.download = `Cipla_Event_${selectedFiles.length}_Moments.zip`;
    link.click();
    setStep('results');
  };

  const toggleSelection = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  return (
    <div className="min-h-screen bg-[#060608] text-[#f5f0e8] font-sans selection:bg-amber-500/30">
      {/* Background Effects */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 -left-1/4 w-1/2 h-1/2 bg-amber-500/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-0 -right-1/4 w-1/2 h-1/2 bg-emerald-500/5 blur-[120px] rounded-full" />
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.03] brightness-100" />
      </div>

      <header className="relative z-10 border-b border-white/5 bg-black/40 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex flex-col">
            <h1 className="text-2xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-amber-200 to-amber-500 leading-none">
              Cipla EventFace EMEU
            </h1>
            <span className="text-[10px] uppercase tracking-[0.2em] text-white/40 mt-1 font-semibold">Moments Reimagined</span>
          </div>

          <div className="flex items-center gap-2">
            {[1, 2, 3].map((s) => (
              <React.Fragment key={s}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-500 ${(s === 1 && step === 'capture') || (s === 2 && step === 'scanning') || (s === 3 && step === 'results')
                  ? 'bg-amber-500 text-black shadow-[0_0_20px_rgba(245,158,11,0.3)]'
                  : s < (step === 'capture' ? 1 : step === 'scanning' ? 2 : 4)
                    ? 'bg-emerald-500 text-black'
                    : 'bg-white/5 text-white/40 border border-white/10'
                  }`}>
                  {s < (step === 'capture' ? 1 : step === 'scanning' ? 2 : 4) ? <Check size={14} /> : s}
                </div>
                {s < 3 && <div className="w-8 h-px bg-white/10" />}
              </React.Fragment>
            ))}
          </div>
        </div>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-6 py-12 md:py-20">
        <AnimatePresence mode="wait">
          {step === 'capture' && (
            <motion.div
              key="capture"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="flex flex-col items-center text-center max-w-2xl mx-auto"
            >
              <span className="inline-block px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-500 text-[10px] uppercase tracking-widest font-bold mb-6">
                Powered by Cipla AI
              </span>
              <h2 className="text-4xl md:text-6xl font-bold mb-6 tracking-tight">
                Find <span className="text-transparent bg-clip-text bg-gradient-to-r from-amber-200 to-amber-500 italic">yourself</span> in the frame
              </h2>
              <p className="text-white/50 text-lg mb-8 max-w-lg">
                Capture a reference photo to automatically sift through thousands of event images and find every moment featuring you.
              </p>

              {/* Event Source Input */}
              <div className="w-full max-w-lg mb-8 space-y-2 text-left">
                <label className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-bold ml-1">Event Folder Link</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-amber-500/50 group-focus-within:text-amber-500 transition-colors">
                    <Search size={18} />
                  </div>
                  <input
                    type="text"
                    value={driveLink}
                    onChange={(e) => setDriveLink(e.target.value)}
                    placeholder="Paste Google Drive folder URL here..."
                    className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-4 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500/50 transition-all placeholder:text-white/20"
                  />
                </div>
                <p className="text-[10px] text-white/30 italic ml-1 font-medium">Link must be a publicly accessible Google Drive folder.</p>
              </div>

              <div className="relative w-full aspect-[4/3] rounded-3xl overflow-hidden bg-white/5 border border-white/10 shadow-2xl mb-10 group">
                {referencePhotos.length === 0 && !isCameraActive && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/30">
                    <div className="w-20 h-20 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-2">
                      <Camera size={32} />
                    </div>
                    <span className="text-sm font-medium tracking-wide">Ready to capture your profile</span>
                  </div>
                )}

                {isCameraActive && (
                  <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover scale-x-[-1]" />
                )}

                {!isCameraActive && referencePhotos.length > 0 && (
                  <div className="w-full h-full relative group">
                    <img src={referencePhotos[referencePhotos.length - 1]} className="w-full h-full object-cover" alt="Reference" />
                    <div className="absolute bottom-4 left-4 right-4 flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                      {referencePhotos.map((photo, i) => (
                        <div key={i} className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 border-amber-500 shadow-lg">
                          <img src={photo} className="w-full h-full object-cover" />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setReferencePhotos(prev => prev.filter((_, idx) => idx !== i));
                            }}
                            className="absolute top-0 right-0 p-0.5 bg-black/60 text-white hover:bg-red-500 transition-colors"
                          >
                            <RefreshCw size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {isCameraActive && (
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-48 h-64 border-2 border-amber-500/40 rounded-[100px] animate-pulse shadow-[0_0_50px_rgba(245,158,11,0.1)]" />
                    <div className="absolute bottom-10 left-1/2 -translate-x-1/2 text-xs font-bold text-amber-500 uppercase tracking-widest bg-black/60 px-4 py-2 rounded-full">
                      Capture {referencePhotos.length}/3 Angles (Front, Left, Right)
                    </div>
                  </div>
                )}

                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>

              {error && (
                <div className="mb-8 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-center gap-3">
                  <AlertCircle size={18} /> {error}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-4 w-full justify-center">
                {!isCameraActive ? (
                  <button
                    onClick={startCamera}
                    className="px-8 py-4 bg-white/5 border border-white/10 rounded-2xl font-bold hover:bg-white/10 transition-all flex items-center justify-center gap-3"
                  >
                    <Camera size={20} className="text-amber-500" /> {referencePhotos.length > 0 ? "Add Another Angle" : "Start Camera"}
                  </button>
                ) : (
                  <div className="flex gap-4">
                    <button
                      onClick={capturePhoto}
                      className="px-8 py-4 bg-amber-500 text-black rounded-2xl font-bold hover:bg-amber-400 transition-all flex items-center justify-center gap-3 shadow-lg shadow-amber-500/20"
                    >
                      Capture Position {referencePhotos.length + 1}
                    </button>
                    <button
                      onClick={stopCamera}
                      className="px-8 py-4 bg-white/5 border border-white/10 rounded-2xl font-bold hover:bg-white/10 transition-all"
                    >
                      Done
                    </button>
                  </div>
                )}

                {!isCameraActive && referencePhotos.length > 0 && (
                  <button
                    onClick={() => setReferencePhotos([])}
                    className="px-8 py-4 bg-white/5 border border-white/10 rounded-2xl font-bold hover:bg-white/10 transition-all flex items-center justify-center gap-3"
                  >
                    <RefreshCw size={20} /> Reset Profile
                  </button>
                )}

                <label className="px-8 py-4 bg-white/5 border border-white/10 rounded-2xl font-bold hover:bg-white/10 transition-all flex items-center justify-center gap-3 cursor-pointer">
                  <Upload size={20} className="text-emerald-500" /> Upload Photos
                  <input type="file" className="hidden" accept="image/*" multiple onChange={handleFileUpload} />
                </label>
              </div>

              {referencePhotos.length > 0 && (
                <motion.button
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  onClick={startScan}
                  disabled={!isModelsLoaded}
                  className="mt-12 w-full max-w-xs px-8 py-5 bg-gradient-to-r from-amber-500 to-amber-600 text-black rounded-2xl font-extrabold text-lg flex items-center justify-center gap-4 hover:brightness-110 transition-all shadow-xl shadow-amber-500/20 disabled:opacity-50"
                >
                  {isModelsLoaded ? (
                    <>Analyze My Matches <ChevronRight size={20} /></>
                  ) : (
                    <><Loader2 size={20} className="animate-spin" /> Loading AI...</>
                  )}
                </motion.button>
              )}
            </motion.div>
          )}

          {step === 'scanning' && (
            <motion.div
              key="scanning"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="max-w-xl mx-auto"
            >
              <div className="bg-white/5 border border-white/10 rounded-3xl p-8 md:p-12 shadow-2xl backdrop-blur-2xl">
                <div className="flex items-center gap-6 mb-12">
                  <div className="relative w-24 h-20 rounded-2xl overflow-hidden border-2 border-amber-500 flex bg-black/40">
                    {referencePhotos.slice(0, 3).map((p, i) => (
                      <img key={i} src={p} className="h-full w-full object-cover first:z-30 even:z-20 last:z-10 -ml-8 first:ml-0" alt="Ref" />
                    ))}
                    <div className="absolute inset-0 bg-blue-500/10 animate-pulse z-40" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold mb-1">Building Identity Profile...</h3>
                    <p className="text-white/40 text-sm">Matching {referencePhotos.length} angles against event vault</p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="flex justify-between items-end mb-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-white/40">{status}</span>
                    <span className="text-2xl font-black text-amber-500">{Math.round(progress)}%</span>
                  </div>
                  <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-gradient-to-r from-amber-500 to-amber-300"
                      initial={{ width: 0 }}
                      animate={{ width: `${progress}%` }}
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-4 pt-8">
                    <div className="bg-white/5 rounded-2xl p-4 text-center">
                      <div className="text-2xl font-bold mb-1">{stats.total}</div>
                      <div className="text-[10px] uppercase tracking-wider text-white/30 font-bold">In Folders</div>
                    </div>
                    <div className="bg-white/5 rounded-2xl p-4 text-center">
                      <div className="text-2xl font-bold mb-1 text-white/60">{stats.scanned}</div>
                      <div className="text-[10px] uppercase tracking-wider text-white/30 font-bold">Scanned</div>
                    </div>
                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4 text-center">
                      <div className="text-2xl font-bold mb-1 text-amber-500">{stats.matches}</div>
                      <div className="text-[10px] uppercase tracking-wider text-amber-500 font-bold">Found You</div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {step === 'results' && (
            <motion.div
              key="results"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-10"
            >
              <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 border-b border-white/5 pb-8">
                <div className="flex-1">
                  <div className="flex items-center gap-4 mb-4">
                    <button
                      onClick={resetApp}
                      className="p-2 rounded-xl bg-white/5 hover:bg-white/10 transition-colors text-white/50 hover:text-white"
                      title="Clear results and scan again"
                    >
                      <ArrowLeft size={20} />
                    </button>
                    <h2 className="text-4xl font-bold tracking-tight">
                      Found your <span className="text-amber-500">{matches.length}</span> moments
                    </h2>
                  </div>
                  <p className="text-white/40 text-lg">
                    Scanned {stats.total} total items across the event folders.
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={() => setShowFilters(!showFilters)}
                    className={`px-6 py-3 rounded-xl font-bold transition-all text-sm flex items-center gap-2 border ${showFilters ? 'bg-amber-500 text-black border-amber-500' : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10'
                      }`}
                  >
                    <Search size={18} /> Filters {showFilters ? 'Active' : ''}
                  </button>
                  <button
                    onClick={resetApp}
                    className="px-6 py-3 bg-white/5 border border-white/10 rounded-xl font-bold hover:bg-white/10 transition-all text-sm text-white/70 flex items-center gap-2"
                  >
                    <RefreshCcw size={16} /> New Search
                  </button>
                  <button
                    onClick={downloadAll}
                    disabled={selectedIds.size === 0}
                    className="px-8 py-3 bg-amber-500 text-black rounded-xl font-bold hover:bg-amber-400 transition-all flex items-center gap-2 text-sm disabled:opacity-50 shadow-lg shadow-amber-500/10"
                  >
                    <Download size={18} /> Download ({selectedIds.size})
                  </button>
                </div>
              </div>

              {/* Filter Panel */}
              <AnimatePresence>
                {showFilters && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="bg-white/5 border border-white/10 rounded-3xl p-6 grid grid-cols-1 md:grid-cols-3 gap-8">
                      {/* Media Type */}
                      <div className="space-y-4">
                        <label className="text-[10px] uppercase font-black tracking-widest text-white/40">Media Type</label>
                        <div className="flex bg-black/40 p-1 rounded-xl border border-white/10">
                          {(['all', 'photo', 'video'] as const).map(t => (
                            <button
                              key={t}
                              onClick={() => setFilterType(t)}
                              className={`flex-1 py-2 text-xs font-bold rounded-lg capitalize transition-all ${filterType === t ? 'bg-amber-500 text-black' : 'text-white/60 hover:text-white'
                                }`}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Match Confidence */}
                      <div className="space-y-4">
                        <div className="flex justify-between items-center">
                          <label className="text-[10px] uppercase font-black tracking-widest text-white/40">Confidence &gt; {minConfidence}%</label>
                          <span className="text-[10px] font-bold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded italic">Higher = More Accurate</span>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="95"
                          step="5"
                          value={minConfidence}
                          onChange={(e) => setMinConfidence(parseInt(e.target.value))}
                          className="w-full accent-amber-500 bg-white/10 h-2 rounded-full appearance-none cursor-pointer"
                        />
                      </div>

                      {/* Date Range Selection */}
                      <div className="space-y-4">
                        <label className="text-[10px] uppercase font-black tracking-widest text-white/40">Timestamp Filter</label>
                        <div className="flex gap-2">
                          <input
                            type="date"
                            className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-bold text-white/70"
                            onChange={(e) => {
                              const val = e.target.valueAsNumber;
                              setDateRange(prev => [val || 0, prev?.[1] || Date.now() + 86400000]);
                            }}
                          />
                          <input
                            type="date"
                            className="flex-1 bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-bold text-white/70"
                            onChange={(e) => {
                              const val = e.target.valueAsNumber;
                              setDateRange(prev => [prev?.[0] || 0, val || Date.now() + 86400000]);
                            }}
                          />
                        </div>
                      </div>

                      {/* Folder Filter */}
                      {uniqueFolders.length > 0 && (
                        <div className="space-y-4">
                          <label className="text-[10px] uppercase font-black tracking-widest text-white/40">Folder Select</label>
                          <select
                            value={selectedFolder}
                            onChange={(e) => setSelectedFolder(e.target.value)}
                            className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2 text-xs font-bold text-white/70"
                          >
                            <option value="all">All Folders</option>
                            {uniqueFolders.map(folder => (
                              <option key={folder} value={folder}>{folder}</option>
                            ))}
                          </select>
                        </div>
                      )}

                      {/* Reset Filters */}
                      <div className="flex items-end col-span-full md:col-span-1">
                        <button
                          onClick={() => {
                            setFilterType('all');
                            setMinConfidence(0);
                            setDateRange(null);
                            setSelectedFolder('all');
                          }}
                          className="w-full py-4 bg-white/5 border border-white/10 hover:bg-white/10 text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-2"
                        >
                          <RefreshCw size={14} /> Reset All Filters
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {filteredMatches.length === 0 ? (
                <div className="py-32 flex flex-col items-center justify-center text-center">
                  <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mb-6 border border-white/10">
                    <Search size={40} className="text-white/20" />
                  </div>
                  <h3 className="text-2xl font-bold mb-2">No moments match filters</h3>
                  <p className="text-white/40 max-w-sm mb-8">Try adjusting your filters or search confidence to see more moments.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {filteredMatches.map((file) => (
                    <motion.div
                      key={file.id}
                      layoutId={file.id}
                      onClick={() => toggleSelection(file.id)}
                      className={`group relative aspect-square rounded-2xl overflow-hidden cursor-pointer border-2 transition-all duration-300 ${selectedIds.has(file.id) ? 'border-amber-500 ring-4 ring-amber-500/10' : 'border-white/5'
                        }`}
                    >
                      <img src={file.thumb} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" alt="Result" />
                      {file.isVideo && (
                        <div className="absolute top-3 left-3 bg-amber-500 text-black px-2 py-1 rounded text-[10px] font-black uppercase flex items-center gap-1 shadow-lg">
                          <Play size={10} fill="currentColor" /> Video
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-4">
                        <div className="text-[10px] uppercase font-black tracking-widest text-amber-500 mb-2">
                          {Math.round((1 - (file.dist || 0)) * 100)}% Match Confidence
                        </div>
                        <button
                          onClick={(e) => downloadOne(e, file)}
                          className="flex items-center gap-2 bg-amber-500 text-black px-3 py-2 rounded-lg text-xs font-bold hover:bg-amber-400 transition-all"
                        >
                          <Download size={14} /> {file.isVideo ? 'Download Video' : 'Download Photo'}
                        </button>
                      </div>

                      <div className={`absolute top-3 right-3 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${selectedIds.has(file.id) ? 'bg-amber-500 border-amber-500 text-black' : 'bg-black/40 border-white/20 text-transparent'
                        }`}>
                        <Check size={14} />
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* "Clear All" Bottom CTA */}
              <motion.div
                className="mt-20 py-12 border-t border-white/5 flex flex-col items-center gap-6"
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
              >
                <p className="text-white/30 text-sm">Want to scan different photos or a different folder?</p>
                <button
                  onClick={resetApp}
                  className="flex items-center gap-2 px-8 py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-white/80 transition-all shadow-sm active:scale-95 text-sm font-bold uppercase tracking-widest"
                >
                  <RefreshCcw size={18} />
                  Clear Results & Restart
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}

