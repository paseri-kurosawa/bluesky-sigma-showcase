import React, { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import { random } from 'graphology-layout';
import forceAtlas2 from 'graphology-layout-forceatlas2';

export default function App() {
  const containerRef = useRef(null);
  const sigmaRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hashtags, setHashtags] = useState([]);
  const [selectedHashtag, setSelectedHashtag] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [panelPos, setPanelPos] = useState(() => ({
    x: 10,
    y: window.innerHeight - 280
  }));
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const apiEndpoint =
    import.meta.env.VITE_API_ENDPOINT || 'http://localhost:3001';

  // Zoom controls
  const handleZoomIn = () => {
    if (sigmaRef.current) {
      sigmaRef.current.getCamera().animatedZoom({ duration: 300, factor: 1.5 });
    }
  };

  const handleZoomOut = () => {
    if (sigmaRef.current) {
      sigmaRef.current.getCamera().animatedZoom({ duration: 300, factor: 0.667 });
    }
  };

  const handleReloadGraph = () => {
    setLoading(true);
    setError(null);
    setGraphData(null);
    setSelectedNode(null);

    const fetchGraphData = async () => {
      try {
        const url = selectedHashtag
          ? `${apiEndpoint}/api/graph/${encodeURIComponent(selectedHashtag)}/latest`
          : `${apiEndpoint}/api/graph/latest`;

        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch graph data');
        const data = await response.json();
        setGraphData(data);
      } catch (err) {
        console.error('Error fetching graph:', err);
        setError(`Failed to reload graph for #${selectedHashtag}`);
      } finally {
        setLoading(false);
      }
    };

    fetchGraphData();
  };

  const handlePanelMouseDown = (e) => {
    setIsDragging(true);
    setDragStart({
      x: e.clientX - panelPos.x,
      y: e.clientY - panelPos.y,
    });
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging) return;
      setPanelPos({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, dragStart]);

  const handleSearch = (e) => {
    e.preventDefault();
    if (!searchQuery.trim() || !graphData || !sigmaRef.current) return;

    const query = searchQuery.toLowerCase();
    const foundNode = graphData.nodes.find(
      (node) =>
        node.label.toLowerCase().includes(query) ||
        (node.displayName && node.displayName.toLowerCase().includes(query))
    );

    if (foundNode) {
      console.log('[Search] Found node:', foundNode.id);
      const nodeAttrs = sigmaRef.current.getGraph().getNodeAttributes(foundNode.id);
      console.log('[Search] Node attributes:', nodeAttrs);

      const camera = sigmaRef.current.getCamera();
      const bbox = sigmaRef.current.getBBox();

      console.log('[Search] Graph BBox:', bbox);

      // Convert graph coordinates to camera coordinates
      const width = bbox.x[1] - bbox.x[0];
      const height = bbox.y[1] - bbox.y[0];

      const normalizedX = (nodeAttrs.x - bbox.x[0]) / width;
      const normalizedY = (nodeAttrs.y - bbox.y[0]) / height;

      console.log('[Search] Normalized coordinates:', { x: normalizedX, y: normalizedY });

      // Animate to node position
      camera.animate(
        {
          x: normalizedX,
          y: normalizedY,
          ratio: 0.01,
        },
        {
          duration: 500,
        }
      );

      setSelectedNode(nodeAttrs);
      setError(null);
    } else {
      setError(`ユーザー「${searchQuery}」が見つかりません`);
    }
  };

  // Fetch available hashtags
  useEffect(() => {
    const fetchHashtags = async () => {
      try {
        const response = await fetch(`${apiEndpoint}/api/hashtags`);
        if (!response.ok) throw new Error('Failed to fetch hashtags');
        const data = await response.json();
        setHashtags(data.hashtags || []);
        if (data.hashtags && data.hashtags.length > 0) {
          setSelectedHashtag(data.hashtags[0]);
        }
      } catch (err) {
        console.error('Error fetching hashtags:', err);
        setError('Failed to fetch available hashtags');
      }
    };

    fetchHashtags();
  }, [apiEndpoint]);

  // Fetch graph data when hashtag changes
  useEffect(() => {
    if (!selectedHashtag) return;

    const fetchGraphData = async () => {
      setLoading(true);
      setError(null);
      setGraphData(null);
      setSelectedNode(null);

      try {
        const url = selectedHashtag
          ? `${apiEndpoint}/api/graph/${encodeURIComponent(selectedHashtag)}/latest`
          : `${apiEndpoint}/api/graph/latest`;

        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch graph data');
        const data = await response.json();
        setGraphData(data);
      } catch (err) {
        console.error('Error fetching graph:', err);
        setError(`Failed to load graph for #${selectedHashtag}`);
      } finally {
        setLoading(false);
      }
    };

    fetchGraphData();
  }, [selectedHashtag, apiEndpoint]);

  // Initialize and update Sigma visualization
  useEffect(() => {
    if (!graphData || !containerRef.current) return;

    // Create graph
    const graph = new Graph();

    // Add nodes
    graphData.nodes.forEach((node) => {
      graph.addNode(node.id, {
        label: node.label,
        displayName: node.displayName,
        followersCount: node.followersCount,
        followsCount: node.followsCount,
        postsCount: node.postsCount,
        avatar: node.avatar,
        size: Math.max(2, Math.min(8, (node.followersCount || 0) / 100)),
        color: '#f5d963',
        x: Math.random(),
        y: Math.random(),
      });
    });

    // Add edges with mutual flag and styling
    let edgeCount = 0;
    let mutualCount = 0;
    graphData.edges.forEach((edge) => {
      try {
        const isMutual = edge.mutual || false;
        graph.addEdge(edge.source, edge.target, {
          mutual: isMutual,
          color: isMutual ? '#b0b0b0' : '#505050',
        });
        edgeCount++;
        if (isMutual) mutualCount++;
      } catch (err) {
        console.warn('[Edge Error]', edge, err.message);
      }
    });

    // Apply layouts: random first, then ForceAtlas2
    try {
      // Step 1: Initialize with random layout
      random.assign(graph);

      // Step 2: Apply ForceAtlas2 force-directed layout
      const settings = forceAtlas2.inferSettings(graph);
      forceAtlas2.assign(graph, {
        iterations: 150,
        settings: settings,
      });
    } catch (err) {
      console.error('[Layout Error]', err);
    }

    // Dispose old Sigma instance
    if (sigmaRef.current) {
      sigmaRef.current.kill();
    }

    // Create new Sigma instance with image rendering
    try {
      const sigma = new Sigma(graph, containerRef.current, {
        renderLabels: false,
        renderEdgeLabels: false,
        defaultEdgeColor: '#808080',
        labelDensity: 0.1,
        labelRenderedSizeThreshold: 8,
        minCameraRatio: 0.1,
        maxCameraRatio: 10,
      });

      sigmaRef.current = sigma;
      window.sigmaInstance = sigma;

      // Fit camera to graph
      sigma.getCamera().animatedZoom();

      // Node click handler
      sigma.on('clickNode', ({ node }) => {
        setSelectedNode(graph.getNodeAttributes(node));
      });

      // Background click handler
      sigma.on('clickStage', () => {
        setSelectedNode(null);
      });
    } catch (err) {
      console.error('Error initializing Sigma:', err);
      setError('Failed to render graph');
    }

    return () => {
      if (sigmaRef.current) {
        sigmaRef.current.kill();
      }
    };
  }, [graphData]);

  return (
    <div className="app-container">
      <div className="header">
        <h1>
          Bluesky User Network Graph
          <select
            id="hashtag-select"
            value={selectedHashtag || ''}
            onChange={(e) => setSelectedHashtag(e.target.value)}
            disabled={loading}
            className="header-select"
          >
            {hashtags.map((tag) => (
              <option key={tag} value={tag}>
                #{tag}
              </option>
            ))}
          </select>
          {graphData && (
            <>
              <div className="stats-inline">
                <div className="stat-group">ユーザー：<span className="stat-value-inline">{graphData.metadata.nodeCount}</span>人</div>
                <div className="stat-group">フォローライン：<span className="stat-value-inline">{graphData.metadata.edgeCount}</span>本</div>
                <div className="stat-group">最終更新：<span className="stat-value-inline">{new Date(graphData.metadata.timestamp).toLocaleDateString('ja-JP')} {new Date(graphData.metadata.timestamp).toLocaleTimeString('ja-JP')}</span></div>
              </div>
              <form onSubmit={handleSearch} className="search-form">
                <input
                  type="text"
                  placeholder="ユーザー名またはハンドルで検索..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="search-input"
                />
                <button type="submit" className="search-btn">検索</button>
              </form>
            </>
          )}
        </h1>
        {error && <div className="error" onClick={() => setError(null)}>{error}</div>}
      </div>

      <div className="content">
        <div className="graph-container">
          <div className="zoom-controls">
            <button onClick={handleZoomIn} title="ズームイン" className="zoom-btn">+</button>
            <button onClick={handleZoomOut} title="ズームアウト" className="zoom-btn">−</button>
            <button onClick={handleReloadGraph} title="グラフをリロード" className="zoom-btn">↻</button>
          </div>
          {loading ? (
            <div className="loading">グラフを読み込み中...</div>
          ) : (
            <>
              <div id="sigma-container" ref={containerRef} />
              <div className="crosshair" />
            </>
          )}
        </div>

        {selectedNode && (
          <div
            className="user-panel"
            style={{
              left: `${panelPos.x}px`,
              top: `${panelPos.y}px`,
              cursor: isDragging ? 'grabbing' : 'grab'
            }}
            onMouseDown={handlePanelMouseDown}
          >
            {selectedNode.avatar && (
              <div className="avatar-container">
                <img key={selectedNode.label} src={selectedNode.avatar} alt="" className="user-avatar" />
              </div>
            )}
            <div className="info-item">
              <div className="info-value display-name">{selectedNode.displayName || 'N/A'}</div>
            </div>
            <div className="info-item">
              <a href={`https://bsky.app/profile/${selectedNode.label}`} target="_blank" rel="noopener noreferrer" className="profile-link">
                {selectedNode.label}
              </a>
            </div>
            <div className="stats-row">
              <span>フォロー: <strong>{selectedNode.followsCount || 0}</strong></span>
              <span>フォロワー: <strong>{selectedNode.followersCount || 0}</strong></span>
              <span>投稿数: <strong>{selectedNode.postsCount || 0}</strong></span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
