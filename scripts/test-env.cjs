// Test-only runtime prerequisites. Production must provision a separately licensed system FFmpeg.
try {
  const ffmpegStaticPath = require('ffmpeg-static');
  const ffprobeStatic = require('ffprobe-static');
  const ffprobeStaticPath = typeof ffprobeStatic === 'string' ? ffprobeStatic : ffprobeStatic?.path;
  if (ffmpegStaticPath && !process.env.FFMPEG_BINARY_PATH) process.env.FFMPEG_BINARY_PATH = ffmpegStaticPath;
  if (ffprobeStaticPath && !process.env.FFPROBE_BINARY_PATH) process.env.FFPROBE_BINARY_PATH = ffprobeStaticPath;
} catch {
  // Allow CI environments that provide ffmpeg on PATH instead.
}
