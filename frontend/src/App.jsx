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
        color: `hsl(${Math.random() * 360}, 70%, 60%)`,
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
          color: isMutual ? '#1da1f2' : '#ccc',
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
        defaultNodeColor: '#1da1f2',
        defaultEdgeColor: '#e1e8ed',
        labelDensity: 0.1,
        labelRenderedSizeThreshold: 8,
        minCameraRatio: 0.1,
        maxCameraRatio: 10,
      });

      sigmaRef.current = sigma;

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
        <h1>Bluesky User Network Graph</h1>
        <p>
          AT Protocol を使用したハッシュタグコミュニティのユーザーネットワーク可視化
        </p>
        <div className="controls">
          <label htmlFor="hashtag-select">ハッシュタグを選択:</label>
          <select
            id="hashtag-select"
            value={selectedHashtag || ''}
            onChange={(e) => setSelectedHashtag(e.target.value)}
            disabled={loading}
          >
            {hashtags.map((tag) => (
              <option key={tag} value={tag}>
                #{tag}
              </option>
            ))}
          </select>

          {graphData && (
            <div className="stats-inline">
              <div className="stat-group">ユーザー：<span className="stat-value-inline">{graphData.metadata.nodeCount}</span>人</div>
              <div className="stat-group">フォローライン：<span className="stat-value-inline">{graphData.metadata.edgeCount}</span>本</div>
              <div className="stat-group">更新日：<span className="stat-value-inline">{new Date(graphData.metadata.timestamp).toLocaleDateString('ja-JP')} {new Date(graphData.metadata.timestamp).toLocaleTimeString('ja-JP')}</span></div>
            </div>
          )}
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      <div className="content">
        <div className="graph-container">
          <div className="zoom-controls">
            <button onClick={handleZoomIn} title="ズームイン" className="zoom-btn">+</button>
            <button onClick={handleZoomOut} title="ズームアウト" className="zoom-btn">−</button>
          </div>
          {loading ? (
            <div className="loading">グラフを読み込み中...</div>
          ) : (
            <div id="sigma-container" ref={containerRef} />
          )}
        </div>

        {selectedNode && (
          <div className="sidebar">
            <h3>ユーザー情報</h3>
            <div className="info-item">
              <div className="info-label">ハンドル</div>
              <div className="info-value">
                <a href={`https://bsky.app/profile/${selectedNode.label}`} target="_blank" rel="noopener noreferrer" className="profile-link">
                  {selectedNode.label}
                </a>
              </div>
            </div>
            <div className="info-item">
              <div className="info-label">表示名</div>
              <div className="info-value">{selectedNode.displayName || 'N/A'}</div>
            </div>
            {selectedNode.avatar && (
              <div className="avatar-container">
                <img src={selectedNode.avatar} alt={selectedNode.label} className="user-avatar" />
              </div>
            )}

            <h3>フォロー統計</h3>
            <div className="info-item">
              <div className="info-label">フォロワー</div>
              <div className="info-value">{selectedNode.followersCount || 0}</div>
            </div>
            <div className="info-item">
              <div className="info-label">フォロー中</div>
              <div className="info-value">{selectedNode.followsCount || 0}</div>
            </div>
            <div className="info-item">
              <div className="info-label">投稿数</div>
              <div className="info-value">{selectedNode.postsCount || 0}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
