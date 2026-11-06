// ==========================================================================
// Terminal Art Download Site Logic
// ==========================================================================

document.addEventListener('DOMContentLoaded', () => {
  const starsBg = document.getElementById('starsBg');
  const downloadBtn = document.getElementById('downloadBtn');

  // ── Spawn Background Twinkling Stars ─────────────────────────────────────
  function initStars(count = 75) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const star = document.createElement('div');
      star.className = 'star';
      const size = Math.random() * 2.2 + 0.8;
      star.style.width = `${size}px`;
      star.style.height = `${size}px`;
      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 100}%`;
      star.style.setProperty('--duration', `${2.5 + Math.random() * 3.5}s`);
      star.style.animationDelay = `${Math.random() * 4}s`;
      fragment.appendChild(star);
    }
    starsBg.appendChild(fragment);
  }
  initStars();

  // ── Download Button Feedback ─────────────────────────────────────────────
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      const btnTitle = downloadBtn.querySelector('.btn-title');
      const origText = btnTitle.textContent;
      btnTitle.textContent = 'Downloading... ♥';
      setTimeout(() => {
        btnTitle.textContent = origText;
      }, 3000);
    });
  }
});
