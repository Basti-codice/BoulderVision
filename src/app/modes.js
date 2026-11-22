// The app's modes: 'setup' (camera, alignment, holds, board), 'live' (tracking, contacts, recording) and 'games'
// (tracking plus the games area). Live and games share the tracking pipeline.
export const isLiveMode = (s) => s.mode === 'live' || s.mode === 'games';
