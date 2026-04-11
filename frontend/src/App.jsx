import React, { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import { random } from 'graphology-layout';
import forceAtlas2 from 'graphology-layout-forceatlas2';

export default function App() {
  const containerRef = useRef(null);
  const sigmaRef = useRef(null);
  const headerRef = useRef(null);
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
  const [showInfo, setShowInfo] = useState(false);
  const [headerHeight, setHeaderHeight] = useState(0);

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
      const nodeAttrs = sigmaRef.current.getGraph().getNodeAttributes(foundNode.id);

      const camera = sigmaRef.current.getCamera();
      const bbox = sigmaRef.current.getBBox();

      // Convert graph coordinates to camera coordinates
      const width = bbox.x[1] - bbox.x[0];
      const height = bbox.y[1] - bbox.y[0];

      const normalizedX = (nodeAttrs.x - bbox.x[0]) / width;
      const normalizedY = (nodeAttrs.y - bbox.y[0]) / height;

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

  // Calculate header height with ResizeObserver
  useEffect(() => {
    if (!headerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (headerRef.current) {
        setHeaderHeight(headerRef.current.offsetHeight + 10);
      }
    });

    resizeObserver.observe(headerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Fetch available hashtags
  useEffect(() => {
    const fetchHashtags = async () => {
      try {
        const response = await fetch(`${apiEndpoint}/api/hashtags`);
        if (!response.ok) throw new Error('Failed to fetch hashtags');
        const data = await response.json();
        let tags = data.hashtags || [];

        // Move "統合" to the end if it exists
        tags = tags.filter(tag => tag !== '統合');
        if (data.hashtags?.includes('統合')) {
          tags.push('統合');
        }

        setHashtags(tags);
        if (tags.length > 0) {
          setSelectedHashtag(tags[0]);
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
      // Determine node color based on last post time
      let nodeColor = '#f5d963'; // Default yellow
      if (node.lastPostAt) {
        const lastPostTime = new Date(node.lastPostAt);
        const now = new Date();
        const diffMs = now - lastPostTime;
        const diffHours = diffMs / (1000 * 60 * 60);

        // Orange-red if posted within last 2 hours
        if (diffHours <= 2) {
          nodeColor = '#ff6b4a';
        }
      }

      graph.addNode(node.id, {
        label: node.displayName,
        displayName: node.displayName,
        accountId: node.label,
        followersCount: node.followersCount,
        followsCount: node.followsCount,
        postsCount: node.postsCount,
        avatar: node.avatar,
        lastPostAt: node.lastPostAt,
        size: Math.max(2, Math.min(8, (node.followersCount || 0) / 100)),
        color: nodeColor,
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
        // Reset all nodes and edges to original colors first
        graph.forEachNode(n => {
          graph.setNodeAttribute(n, 'color', '#f5d963');
        });
        graph.forEachEdge(e => {
          const edgeData = graph.getEdgeAttributes(e);
          graph.setEdgeAttribute(e, 'color', edgeData.mutual ? '#b0b0b0' : '#505050');
        });

        // Now apply highlight for selected node
        setSelectedNode(graph.getNodeAttributes(node));

        const neighbors = graph.neighbors(node);
        const selectedNodeSet = new Set([node, ...neighbors]);

        // Grayscale unrelated nodes only
        graph.forEachNode(n => {
          if (!selectedNodeSet.has(n)) {
            graph.setNodeAttribute(n, 'color', '#aaa');
          }
        });

        // Collect connected edges
        const connectedEdges = new Set();
        graph.forEachOutboundEdge(node, e => {
          connectedEdges.add(e);
        });
        graph.forEachInboundEdge(node, e => {
          connectedEdges.add(e);
        });

        // Make unrelated edges very dark (nearly black)
        graph.forEachEdge(e => {
          if (!connectedEdges.has(e)) {
            graph.setEdgeAttribute(e, 'color', '#222222');
          }
        });
      });

      // Background click handler
      sigma.on('clickStage', () => {
        setSelectedNode(null);

        // Reset all nodes and edges to original colors
        graph.forEachNode(n => {
          const nodeAttrs = graph.getNodeAttributes(n);
          // Determine color based on last post time
          let nodeColor = '#f5d963'; // Default yellow
          if (nodeAttrs.lastPostAt) {
            const lastPostTime = new Date(nodeAttrs.lastPostAt);
            const now = new Date();
            const diffMs = now - lastPostTime;
            const diffHours = diffMs / (1000 * 60 * 60);

            // Orange-red if posted within last 2 hours
            if (diffHours <= 2) {
              nodeColor = '#ff6b4a';
            }
          }
          graph.setNodeAttribute(n, 'color', nodeColor);
        });
        graph.forEachEdge(e => {
          const edgeData = graph.getEdgeAttributes(e);
          graph.setEdgeAttribute(e, 'color', edgeData.mutual ? '#b0b0b0' : '#505050');
        });
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
      <div className="header" ref={headerRef}>
        <h1>
          Bluesky User Network Graph
          <button
            onClick={() => setShowInfo(!showInfo)}
            className="info-btn"
            title="サービスの説明"
          >
            ？
          </button>
          <select
            id="hashtag-select"
            value={selectedHashtag || ''}
            onChange={(e) => setSelectedHashtag(e.target.value)}
            disabled={loading}
            className="header-select"
          >
            {hashtags.map((tag) => (
              <option key={tag} value={tag}>
                {tag === '統合' ? tag : `#${tag}`}
              </option>
            ))}
          </select>
          {graphData && (
            <>
              <div className="stats-inline">
                <div className="stat-group">ユーザー：<span className="stat-value-inline">{graphData.metadata.nodeCount}</span>人</div>
                <div className="stat-group">エッジ：<span className="stat-value-inline">{graphData.metadata.edgeCount}</span>本</div>
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

        {showInfo && (
          <>
            <div className="modal-overlay" onClick={() => setShowInfo(false)} />
            <div className="info-modal" style={{ top: `${headerHeight}px` }}>
              <div className="info-modal-header">
                <h2>Bluesky User Network Graph について</h2>
                <button
                  onClick={() => setShowInfo(false)}
                  className="close-btn"
                >
                  ×
                </button>
              </div>
              <div className="info-modal-content">
                <p><strong>このサイトは何？</strong></p>
                <p><a href="https://bsky.app/" target="_blank" rel="noopener noreferrer">Bluesky</a>の日本語圏ユーザーネットワークを可視化するツールです。<br />選択したハッシュタグに関連するユーザーをグラフとして表示します。<br />反映されている情報は必ずしも最新ではありません。</p>

                <p><strong>グラフについて</strong></p>
                <p>• 各ノード（円）がユーザーを表します</p>
                <p>• ノードのサイズはフォロワー数に比例します</p>
                <p>• エッジ（線）がフォロー関係を表します</p>
                <p>• 濃い灰色の線は相互フォロー、薄い灰色は片方向フォローです</p>
                <p>• 直近で関連するポストをしているユーザーはオレンジ色で表示されます</p>

                <p><strong>機能</strong></p>
                <p>• ハッシュタグを選択してグラフを切り替え</p>
                <p>• 検索ボックスでユーザーを検索</p>
                <p>• ズームコントロールで拡大・縮小</p>
                <p>• ノードをクリックするとユーザー情報を表示</p>

                <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid #ccc' }} />
                <p style={{ fontSize: '0.9em', color: '#666' }}>created by <a href="https://bsky.app/profile/paseri-kurosawa.bsky.social" target="_blank" rel="noopener noreferrer">@paseri-kurosawa.bsky.social</a></p>
              </div>
            </div>
          </>
        )}

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
              <a href={`https://bsky.app/profile/${selectedNode.accountId}`} target="_blank" rel="noopener noreferrer" className="profile-link">
                {selectedNode.accountId}
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
