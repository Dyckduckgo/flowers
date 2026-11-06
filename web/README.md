# Terminal Artwork — Windows Download Website

This directory contains the complete landing page for your terminal artwork, specifically designed to distribute and download **`for you.exe`**.

---

## 🚀 How to Publish to Netlify / Vercel

### Option A: Publish on Netlify (Fastest)

1. Open **[Netlify Drop](https://app.netlify.com/drop)** in your web browser.
2. Sign in to your Netlify account (free).
3. Drag and drop this entire `web/` folder into the upload zone.
4. Netlify will publish your site in seconds and give you a live URL (`https://your-site.netlify.app`).

---

### Option B: Publish on Vercel

1. Push your repository to GitHub.
2. Go to **[vercel.com](https://vercel.com)** and click **Add New Project**.
3. Import your GitHub repository.
4. In the configuration step, click **Edit** next to **Root Directory** and select `web`.
5. Click **Deploy**. Your site is now live at `https://your-project.vercel.app`!

---

## 📁 Files in This Folder

- **`index.html`**: The download landing page with the starry night card presentation, one-click download button, terminal preview screenshots, and quick-start instructions.
- **`style.css`**: Styling, starry background, neon accents, and responsive layout for mobile and desktop.
- **`script.js`**: Background star generation and download button interactions.
- **`assets/for_you.exe`**: The standalone Windows 10/11 application (48 MB) served directly to visitors.
- **`assets/for_you.png`** & **`assets/preview.png`**: Screenshots showcasing what the artwork looks like in the terminal.
- **`vercel.json`** & **`netlify.toml`**: Download headers ensuring the `.exe` triggers as a direct file attachment.
