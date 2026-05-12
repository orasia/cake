// CakePreview — fetches a photo of the configured cake from the server's
// /api/cake-photo endpoint. Cached photos return instantly; uncached
// combinations are generated on demand via Gemini (server-side) and
// cached for next time. The owner can force regeneration by adding
// ?owner=1 to the page URL and clicking the small refresh control.

const PHOTO_API = '/api/cake-photo';

const isOwner = () => new URLSearchParams(window.location.search).has('owner');

// === 3D interactive viewer (review step) =============================

const PASTEL_HEX = {
  ivory:  '#EFE7D5', butter: '#F1D778', blush:  '#F2B0A0',
  peach:  '#E89A82', lilac:  '#B7A1D7', sage:   '#9AB48F',
  rose:   '#B7717A', sky:    '#6F9AC0', navy:   '#283246', noir:   '#1A140F',
};

const ThreeDCake = ({ shape, sizeInch, colorHex, patternId }) => {
  const mountRef = React.useRef(null);
  const stateRef = React.useRef(null);

  // Build the scene once on mount.
  React.useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !window.THREE) return;
    const THREE = window.THREE;

    const W = mount.clientWidth || 460;
    const H = mount.clientHeight || 460;
    const scene = new THREE.Scene();
    scene.background = null;

    const camera = new THREE.PerspectiveCamera(28, W / H, 0.1, 100);
    camera.position.set(0, 6.5, 26);
    camera.lookAt(0, -1.5, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;cursor:grab;';

    // Studio-room environment for IBL reflections.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(renderer), 0.04).texture;
    pmrem.dispose();

    // Soft direction lights for shape definition.
    const key = new THREE.DirectionalLight(0xfff4e6, 0.5);
    key.position.set(6, 12, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 40;
    key.shadow.camera.left = -10; key.shadow.camera.right = 10;
    key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
    key.shadow.bias = -0.0005; key.shadow.radius = 4;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xe6f0ff, 0.15);
    fill.position.set(-8, 4, 4);
    scene.add(fill);

    // Cake stand: lathed ceramic pedestal.
    const STAND_TOP = -3.4, STAND_H = 3.0;
    const stand = new THREE.Mesh(
      new THREE.LatheGeometry([
        new THREE.Vector2(0.0, 0.00), new THREE.Vector2(3.6, 0.00),
        new THREE.Vector2(3.6, 0.18), new THREE.Vector2(3.0, 0.30),
        new THREE.Vector2(1.4, 0.36), new THREE.Vector2(0.95, 0.55),
        new THREE.Vector2(0.95, 2.10), new THREE.Vector2(1.4, 2.34),
        new THREE.Vector2(6.8, 2.40), new THREE.Vector2(7.3, 2.56),
        new THREE.Vector2(7.3, 2.80), new THREE.Vector2(7.0, 2.96),
        new THREE.Vector2(0.0, 3.00),
      ], 128),
      new THREE.MeshStandardMaterial({ color: 0xeae5dc, roughness: 0.28, metalness: 0.02, envMapIntensity: 1.1 }),
    );
    stand.position.y = STAND_TOP - STAND_H;
    stand.castShadow = true; stand.receiveShadow = true;
    scene.add(stand);

    // Soft ground.
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(50, 64),
      new THREE.MeshStandardMaterial({ color: 0xece4d4, roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = STAND_TOP - STAND_H;
    ground.receiveShadow = true;
    scene.add(ground);

    const cakeGroup = new THREE.Group();
    scene.add(cakeGroup);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, -1.5, 0);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.7;
    controls.minDistance = 16;
    controls.maxDistance = 38;
    controls.minPolarAngle = Math.PI / 3;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.update();
    renderer.domElement.addEventListener('pointerdown', () => { renderer.domElement.style.cursor = 'grabbing'; });
    renderer.domElement.addEventListener('pointerup',   () => { renderer.domElement.style.cursor = 'grab'; });

    let animId = 0;
    const animate = () => { animId = requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); };
    animate();

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);

    stateRef.current = { THREE, scene, renderer, cakeGroup, controls };

    return () => {
      ro.disconnect();
      if (animId) cancelAnimationFrame(animId);
      controls.dispose();
      renderer.dispose();
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
      stateRef.current = null;
    };
  }, []);

  // Rebuild the cake mesh whenever shape/colour/size/pattern changes.
  React.useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    const { THREE, cakeGroup } = st;

    // Clear previous cake.
    while (cakeGroup.children.length) {
      const m = cakeGroup.children[0];
      cakeGroup.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (Array.isArray(m.material)) m.material.forEach((mm) => mm.dispose());
      else if (m.material) m.material.dispose();
    }

    const buildSideMat = (cb) => {
      const topMat = new THREE.MeshStandardMaterial({
        color: colorHex, roughness: 0.85, metalness: 0.0, envMapIntensity: 0.2,
      });
      if (!patternId || patternId === 'none') {
        cb(new THREE.MeshStandardMaterial({
          color: colorHex, roughness: 0.85, metalness: 0.0, envMapIntensity: 0.2,
        }), topMat);
        return;
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 1024; c.height = 1024;
        const cx = c.getContext('2d');
        cx.imageSmoothingEnabled = true;
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(img, 0, 0, 1024, 1024);
        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.encoding = THREE.sRGBEncoding;
        tex.anisotropy = 8;
        if (/round/i.test(shape)) tex.repeat.set(4, 1); else tex.repeat.set(1, 1);
        tex.needsUpdate = true;
        cb(new THREE.MeshStandardMaterial({
          map: tex, roughness: 0.85, metalness: 0.0, envMapIntensity: 0.2,
        }), topMat);
      };
      img.onerror = () => cb(new THREE.MeshStandardMaterial({
        color: colorHex, roughness: 0.85,
      }), topMat);
      img.src = `assets/patterns-png/${patternId}.png`;
    };

    const STAND_TOP_Y = -3.4;
    const sc = 0.62 + ((sizeInch || 5) - 4) * 0.136;

    buildSideMat((sideMat, topMat) => {
      if (shape === 'round') {
        const R = 4.0 * sc, Hc = 6.6 * sc;
        const side = new THREE.Mesh(
          new THREE.CylinderGeometry(R, R, Hc, 96, 1, true),
          sideMat,
        );
        side.position.y = STAND_TOP_Y + Hc / 2;
        side.castShadow = true; side.receiveShadow = true;
        const top = new THREE.Mesh(new THREE.CircleGeometry(R, 96), topMat);
        top.rotation.x = -Math.PI / 2;
        top.position.y = STAND_TOP_Y + Hc;
        cakeGroup.add(side); cakeGroup.add(top);
      } else {
        const Sw = 6.0 * sc, Sh = 6.6 * sc;
        const cake = new THREE.Mesh(
          new THREE.BoxGeometry(Sw, Sh, Sw),
          [sideMat, sideMat, topMat, topMat, sideMat, sideMat],
        );
        cake.position.y = STAND_TOP_Y + Sh / 2;
        cake.rotation.y = -Math.PI / 12;
        cake.castShadow = true; cake.receiveShadow = true;
        cakeGroup.add(cake);
      }
    });
  }, [shape, sizeInch, colorHex, patternId]);

  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: 460, aspectRatio: '1/1' }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0 }}/>
      <div style={{
        position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
        fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.16em',
        textTransform: 'uppercase', color: 'var(--fg-subtle)',
        background: 'rgba(252,250,246,0.72)', padding: '6px 12px', borderRadius: 999,
        backdropFilter: 'blur(6px)',
        pointerEvents: 'none',
      }}>
        Drag to rotate · scroll to zoom
      </div>
    </div>
  );
};

// === Main preview component ==========================================

const CakePreview = ({
  shape, sizeInch, color, message, hasMessage, messageMode, messageFont, pattern, allow3D,
}) => {
  // All hooks must run unconditionally on every render — React enforces
  // the rules of hooks. Branch in the JSX below, not via early return.

  const colorId   = color?.id || 'blush';
  const patternId = pattern || 'none';
  const sizeRound = Math.max(3, Math.min(9, Math.round(sizeInch || 5)));
  // When the user is composing a "top" message we ask the server for a
  // top-down view of the cake so the message overlay actually lands on
  // the visible top surface. Other steps stay on the regular side view.
  const photoView = (messageMode === 'top' && hasMessage) ? 'top' : 'side';

  const [show3D, setShow3D] = React.useState(false);
  React.useEffect(() => { if (!allow3D) setShow3D(false); }, [allow3D]);

  const [photoUrl, setPhotoUrl]   = React.useState(null);
  const [loading,  setLoading]    = React.useState(true);
  const [error,    setError]      = React.useState(null);
  const [generating, setGenerating] = React.useState(false);
  const [bust,     setBust]       = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    // Debounce: wait 450ms after the user stops changing picks before
    // hitting the server. This way rapid clicks through wrap/colour cards
    // coalesce into one fetch, and typing-while-thinking on the message
    // step doesn't trigger generation mid-thought.
    setLoading(true);
    setError(null);
    setPhotoUrl(null);
    setGenerating(false);

    const params = new URLSearchParams({
      shape, colorId, patternId, sizeInch: String(sizeRound), view: photoView,
      ...(bust > 0 ? { force: '1' } : {}),
    });
    const url = `${PHOTO_API}?${params.toString()}`;

    let slowTimer;
    const runFetch = () => {
      // Mark "generating" pre-flight so the spinner explains the wait if
      // the response takes more than ~400ms (cache misses).
      slowTimer = setTimeout(() => { if (!cancelled) setGenerating(true); }, 400);

      fetch(url)
        .then(async (r) => {
          clearTimeout(slowTimer);
          if (!r.ok) {
            const body = await r.json().catch(() => ({}));
            throw new Error(body.error || `HTTP ${r.status}`);
          }
          return r.json();
        })
        .then((data) => {
          if (cancelled) return;
          setPhotoUrl(data.url + (bust > 0 ? `?b=${bust}` : ''));
          setGenerating(false);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e.message || String(e));
          setGenerating(false);
          setLoading(false);
        });
    };

    const debounce = setTimeout(runFetch, 450);

    return () => {
      cancelled = true;
      clearTimeout(debounce);
      if (slowTimer) clearTimeout(slowTimer);
    };
  }, [shape, colorId, patternId, sizeRound, photoView, bust]);

  // Visual scale based on selected size, clamped at 1.0 so the photo
  // (and its SVG overlay) never overflows the 460-square stage. The
  // 3-inch cake shows at ~62%, the 9-inch at the full container width.
  const sc = Math.min(1.0, 0.62 + (sizeRound - 4) * 0.085);
  const lightColors = ['ivory','butter','blush','peach','lilac','sage'];
  const isLight = lightColors.includes(colorId);
  const ink = isLight ? '#3D2C1F' : '#FBFAF7';
  const inkShadow = isLight ? 'rgba(0,0,0,0.30)' : 'rgba(0,0,0,0.55)';

  // 3D view at the review step — opt-in via the "Rotate in 3D" button.
  // Note: kept inside a branch but AFTER all hooks have run, so React's
  // rules of hooks aren't violated.
  if (show3D && allow3D && window.THREE) {
    return (
      <div style={{ position: 'relative', width: '100%', maxWidth: 460, aspectRatio: '1/1' }}>
        <ThreeDCake
          shape={shape}
          sizeInch={sizeInch}
          colorHex={color?.hex || PASTEL_HEX[color?.id] || '#F2B0A0'}
          patternId={pattern || 'none'}
        />
        <button
          onClick={() => setShow3D(false)}
          style={{
            position: 'absolute', top: 10, right: 10,
            padding: '7px 12px', borderRadius: 999,
            background: 'rgba(0,0,0,0.78)', color: '#fff', border: 0,
            fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em',
            textTransform: 'uppercase', cursor: 'pointer',
          }}
        >
          ← Photo view
        </button>
      </div>
    );
  }

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      maxWidth: 460,
      aspectRatio: '1 / 1',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      {photoUrl && (
        <img
          src={photoUrl}
          alt={`${color?.name || 'Cake'} ${shape} cake with ${patternId === 'none' ? 'no wrap' : patternId} pattern`}
          onLoad={() => setLoading(false)}
          onError={() => { setError('image failed to load'); setLoading(false); }}
          style={{
            width: `${sc * 100}%`,
            height: 'auto',
            maxHeight: '100%',
            objectFit: 'contain',
            display: 'block',
            opacity: loading ? 0 : 1,
            transition: 'opacity 400ms ease, width 600ms cubic-bezier(0.32,0.72,0.24,1)',
            filter: 'drop-shadow(0 22px 38px rgba(26,18,11,0.20))',
          }}
        />
      )}

      {/* Hand-piped message overlay (SVG) on top of the photo */}
      {photoUrl && hasMessage && message && !loading && (
        <svg
          viewBox="0 0 1000 1062"
          preserveAspectRatio="xMidYMid meet"
          style={{
            position: 'absolute',
            inset: 0,
            width: `${sc * 100}%`,
            height: 'auto',
            margin: 'auto',
            pointerEvents: 'none',
          }}
        >
          <defs>
            {/* Top message on the regular SIDE-view photo (fallback if the
                top-down view fails). The cake top ellipse sits high in the
                frame, so the arc threads across the visible top band. */}
            <path id="msgArcTop"     d="M 360,330 A 280,22 0 0 0 640,330" fill="none"/>
            {/* Top message on the TOP-DOWN-view photo. The pink disc fills
                the centre of the frame — arc threads across its centre
                with a gentle smile so the text reads as piped on icing. */}
            <path id="msgArcTopFlat" d="M 200,470 A 720,40 0 0 0 800,470" fill="none"/>
            {/* Around-the-cake: lower side wraparound arc. */}
            <path id="msgArcWrap"    d="M 280,640 A 430,90 0 0 0 720,640" fill="none"/>
          </defs>
          <MessageOnCake
            shape={shape}
            mode={messageMode}
            message={message}
            view={photoView}
            ink={ink}
            inkShadow={inkShadow}
            fontFamily={messageFont?.family || '"Allison", cursive'}
          />
        </svg>
      )}

      {(loading || generating) && !error && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--fg-subtle)',
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: '50%',
            border: '2px solid rgba(0,0,0,0.08)',
            borderTopColor: 'var(--pop-500)',
            animation: 'spin 0.9s linear infinite',
          }}/>
          <div>{generating ? 'Baking your cake preview…' : 'Loading…'}</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {error && !loading && (
        <div style={{
          padding: '14px 18px',
          textAlign: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          maxWidth: '70%',
        }}>
          <div style={{ marginBottom: 8 }}>Preview unavailable</div>
          <div style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>{error}</div>
        </div>
      )}

      {/* Owner controls — only shown when ?owner=1 is in the URL */}
      {isOwner() && (
        <div style={{
          position: 'absolute',
          bottom: 8,
          right: 8,
          display: 'flex',
          gap: 6,
        }}>
          <button
            onClick={() => setBust(Date.now())}
            disabled={generating || loading}
            title="Regenerate this cake photo via Gemini"
            style={{
              padding: '6px 10px',
              borderRadius: 999,
              background: 'rgba(0,0,0,0.78)',
              color: '#fff',
              border: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              opacity: generating || loading ? 0.45 : 1,
            }}
          >
            ↻ Regenerate
          </button>
        </div>
      )}

      {/* "Rotate in 3D" toggle — only on the review step */}
      {allow3D && photoUrl && !loading && (
        <button
          onClick={() => setShow3D(true)}
          style={{
            position: 'absolute',
            top: 10, right: 10,
            padding: '7px 12px', borderRadius: 999,
            background: 'rgba(0,0,0,0.78)', color: '#fff', border: 0,
            fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em',
            textTransform: 'uppercase', cursor: 'pointer',
          }}
        >
          ↻ Rotate in 3D
        </button>
      )}
    </div>
  );
};

const MessageOnCake = ({ shape, mode, message, view, ink, inkShadow, fontFamily }) => {
  const len    = message.length;
  const family = fontFamily || '"Allison", cursive';
  const isScript = /Allison|Caveat|cursive/i.test(family);
  const base = isScript ? 1.25 : 1.0;
  const commonStyle = {
    paintOrder: 'stroke',
    stroke: inkShadow,
    strokeWidth: 1.0,
    strokeOpacity: 0.30,
  };

  if (mode === 'around') {
    const fontSize = Math.round((len <= 8 ? 56 : len <= 16 ? 42 : 32) * base);
    const fullText = (message + '  ·  ').repeat(3);
    return (
      <text
        fontFamily={family}
        fontWeight="500"
        fontSize={fontSize}
        fill={ink}
        style={{ ...commonStyle, letterSpacing: '0.02em' }}
      >
        <textPath href="#msgArcWrap" startOffset="50%" textAnchor="middle">
          {fullText}
        </textPath>
      </text>
    );
  }

  // mode === 'top' — message sits on the top surface of the cake.
  // When we're showing the TOP-DOWN view, the cake-top disc fills most
  // of the frame so we can use much bigger text. Font size shrinks as
  // the message gets longer so it always fits on the disc.
  if (view === 'top') {
    let fontSize;
    if (len <= 6)       fontSize = 160;
    else if (len <= 10) fontSize = 130;
    else if (len <= 16) fontSize = 100;
    else if (len <= 22) fontSize = 78;
    else                fontSize = 62;
    fontSize = Math.round(fontSize * base);
    return (
      <text
        fontFamily={family}
        fontWeight="500"
        fontSize={fontSize}
        fill={ink}
        style={{ ...commonStyle, letterSpacing: '-0.005em', strokeWidth: 1.5 }}
      >
        <textPath href="#msgArcTopFlat" startOffset="50%" textAnchor="middle">
          {message.length > 28 ? message.slice(0,28) : message}
        </textPath>
      </text>
    );
  }

  // Side view fallback: text on the narrow top ellipse band.
  if (shape === 'square') {
    const fontSize = Math.round((len <= 8 ? 70 : len <= 16 ? 52 : 38) * base);
    return (
      <text
        x="500" y="340"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily={family}
        fontWeight="500"
        fontSize={fontSize}
        fill={ink}
        style={{ ...commonStyle, letterSpacing: '-0.005em' }}
      >
        {message.length > 28 ? message.slice(0,28) : message}
      </text>
    );
  }

  const fontSize = Math.round((len <= 8 ? 78 : len <= 16 ? 56 : 42) * base);
  return (
    <text
      fontFamily={family}
      fontWeight="500"
      fontSize={fontSize}
      fill={ink}
      style={{ ...commonStyle, letterSpacing: '-0.005em' }}
    >
      <textPath href="#msgArcTop" startOffset="50%" textAnchor="middle">
        {message.length > 28 ? message.slice(0,28) : message}
      </textPath>
    </text>
  );
};

window.CakePreview = CakePreview;
