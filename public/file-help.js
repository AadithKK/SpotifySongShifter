// A directly opened HTML file cannot run Music Inbox's server-backed features.
if (location.protocol === 'file:') {
  document.addEventListener('DOMContentLoaded', () => {
    document.title = 'Start Music Inbox';
    const main = document.createElement('main');
    main.style.cssText = 'box-sizing:border-box;width:min(520px,calc(100% - 32px));margin:12vh auto;padding:34px;border:1px solid rgba(150,190,255,.28);border-radius:24px;background:rgba(34,55,97,.72);box-shadow:0 25px 80px rgba(0,0,0,.25);font:16px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;';
    const heading = document.createElement('h1');
    heading.textContent = 'Start Music Inbox first';
    heading.style.cssText = 'font-size:27px;line-height:1.2;margin:0 0 12px;';
    const explanation = document.createElement('p');
    explanation.textContent = 'This HTML file needs the Music Inbox server to load its design and connect to Spotify.';
    const steps = document.createElement('p');
    steps.textContent = 'On a Mac, double-click “Start Music Inbox.command” in the project folder. On Windows or Linux, open a terminal in the project folder and run npm ci, then npm start.';
    const link = document.createElement('a');
    link.href = 'http://127.0.0.1:4173/';
    link.textContent = 'Open Music Inbox';
    link.style.cssText = 'display:inline-block;margin-top:12px;padding:11px 18px;border-radius:12px;background:#73a6ff;color:#091a37;font-weight:700;text-decoration:none;';
    const hint = document.createElement('small');
    hint.textContent = 'If the link does not open, start the server first and try again.';
    hint.style.cssText = 'display:block;margin-top:14px;color:#bfd1ec;';
    main.append(heading, explanation, steps, link, hint);
    document.body.replaceChildren(main);
    document.body.style.cssText = 'margin:0;min-height:100vh;background:radial-gradient(circle at 15% 5%,#294777,#101b35 50%,#090f22);color:#f5f9ff;';
  });
}
