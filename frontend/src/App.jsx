import React, { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import Graph from 'graphology';
import { random } from 'graphology-layout';
import forceAtlas2 from 'graphology-layout-forceatlas2';

export default function App() {
  const containerRef = useRef(null);
  const sigmaRef = useRef(null);
  const headerRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hashtags, setHashtags] = useState([]);
  const [selectedHashtag, setSelectedHashtag] = useState(null);
  const [selectedFilterHashtag, setSelectedFilterHashtag] = useState(null);
  const [graphData, setGraphData] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [panelPos, setPanelPos] = useState(() => ({
    x: 10,
    y: window.innerHeight - 380
  }));
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [showInfo, setShowInfo] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [statsTab, setStatsTab] = useState('ranking');
  const [panelTab, setPanelTab] = useState('info');
  const [headerHeight, setHeaderHeight] = useState(0);
  const [recommendedUsers, setRecommendedUsers] = useState([]);
  const [topPost, setTopPost] = useState(null);
  const [topPostLoading, setTopPostLoading] = useState(false);
  const [shareImageLoading, setShareImageLoading] = useState(false);
  const [tabCooldown, setTabCooldown] = useState(0);
  const [autoSelectHandle, setAutoSelectHandle] = useState(null);

  const apiEndpoint =
    import.meta.env.VITE_API_ENDPOINT || 'http://localhost:3001';

  // Initialize from URL parameters on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const network = params.get('network');
    const handle = params.get('handle');

    if (network) {
      setSelectedHashtag(network);
    }

    if (handle) {
      setAutoSelectHandle(handle);
    }
  }, []); // Run only on mount

  // Helper: Select node with highlight and camera animation
  // Accepts either (nodeId, graph, sigma) or just (nodeId) for external use with sigmaRef
  const selectNodeAndHighlight = (nodeId, graph, sigma) => {
    const g = graph || sigmaRef.current.getGraph();
    const s = sigma || sigmaRef.current;

    const nodeAttrs = g.getNodeAttributes(nodeId);
    nodeAttrs.id = nodeId;
    setSelectedNode(nodeAttrs);

    // Animate camera to node
    const camera = s.getCamera();
    const bbox = s.getBBox();
    const width = bbox.x[1] - bbox.x[0];
    const height = bbox.y[1] - bbox.y[0];
    const normalizedX = (nodeAttrs.x - bbox.x[0]) / width;
    const normalizedY = (nodeAttrs.y - bbox.y[0]) / height;

    camera.animate(
      {
        x: normalizedX,
        y: normalizedY,
        ratio: 0.01,
      },
      { duration: 600 }
    );

    // Reset all colors
    g.forEachNode(n => {
      g.setNodeAttribute(n, 'color', '#f5d963');
    });
    g.forEachEdge(e => {
      const edgeData = g.getEdgeAttributes(e);
      g.setEdgeAttribute(e, 'color', edgeData.mutual ? '#b0b0b0' : '#505050');
    });

    // Highlight selected node and neighbors
    const neighbors = g.neighbors(nodeId);
    const selectedNodeSet = new Set([nodeId, ...neighbors]);

    g.forEachNode(n => {
      if (n === nodeId) {
        g.setNodeAttribute(n, 'color', '#26C6DA');
      } else if (!selectedNodeSet.has(n)) {
        g.setNodeAttribute(n, 'color', '#aaa');
      }
    });

    // Highlight connected edges
    const connectedEdges = new Set();
    g.forEachOutboundEdge(nodeId, e => {
      connectedEdges.add(e);
    });
    g.forEachInboundEdge(nodeId, e => {
      connectedEdges.add(e);
    });

    g.forEachEdge(e => {
      if (!connectedEdges.has(e)) {
        g.setEdgeAttribute(e, 'color', '#222222');
      }
    });
  };

  // Calculate recommended users (2-hop connections)
  const calculateRecommendedUsers = (userId) => {
    if (!sigmaRef.current || !graphData) return [];

    const graph = sigmaRef.current.getGraph();
    const directConnections = new Set([userId]); // Start with the user itself

    // Get all direct connections (both directions)
    graph.forEachOutboundEdge(userId, (edge, attrs, source, target) => {
      directConnections.add(target);
    });
    graph.forEachInboundEdge(userId, (edge, attrs, source, target) => {
      directConnections.add(source);
    });

    // Get 2-hop connections
    const twoHopCandidates = new Set();
    directConnections.forEach(nodeId => {
      // From direct connections, get their connections
      graph.forEachOutboundEdge(nodeId, (edge, attrs, source, target) => {
        if (!directConnections.has(target)) {
          twoHopCandidates.add(target);
        }
      });
      graph.forEachInboundEdge(nodeId, (edge, attrs, source, target) => {
        if (!directConnections.has(source)) {
          twoHopCandidates.add(source);
        }
      });
    });

    // Convert to array and shuffle
    const candidates = Array.from(twoHopCandidates);
    const shuffled = candidates.sort(() => Math.random() - 0.5);

    // Get top 3 and fetch their data
    const recommended = shuffled.slice(0, 3).map(nodeId => {
      const nodeAttrs = graph.getNodeAttributes(nodeId);
      return {
        id: nodeId,
        displayName: nodeAttrs.displayName || nodeAttrs.label,
        accountId: nodeAttrs.accountId || nodeAttrs.label,
        avatar: nodeAttrs.avatar,
        followersCount: nodeAttrs.followersCount,
      };
    });

    return recommended;
  };

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
        if (!selectedHashtag) {
          throw new Error('Hashtag not selected');
        }
        const url = `https://${window.location.hostname}/sigma-graph/${encodeURIComponent(selectedHashtag)}/users_merged.json`;

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

  const handleFetchTopPost = async (handle) => {
    if (tabCooldown > 0) return; // Block if in cooldown

    setTopPostLoading(true);
    setTabCooldown(1); // Start 1-second cooldown

    try {
      const response = await fetch(
        `${apiEndpoint}/api/user/${encodeURIComponent(handle)}/top-post`
      );
      if (!response.ok) throw new Error('Failed to fetch top post');
      const post = await response.json();
      setTopPost(post);
    } catch (err) {
      console.error('Error fetching top post:', err);
      setTopPost({ error: err.message });
    } finally {
      setTopPostLoading(false);
    }
  };

  const handlePanelMouseDown = (e) => {
    setIsDragging(true);
    setDragStart({
      x: e.clientX - panelPos.x,
      y: e.clientY - panelPos.y,
    });
  };

  const handlePanelTouchStart = (e) => {
    setIsDragging(true);
    setDragStart({
      x: e.touches[0].clientX - panelPos.x,
      y: e.touches[0].clientY - panelPos.y,
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

    const handleTouchMove = (e) => {
      if (!isDragging) return;
      setPanelPos({
        x: e.touches[0].clientX - dragStart.x,
        y: e.touches[0].clientY - dragStart.y,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.addEventListener('touchmove', handleTouchMove);
      document.addEventListener('touchend', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('touchmove', handleTouchMove);
        document.removeEventListener('touchend', handleMouseUp);
      };
    }
  }, [isDragging, dragStart]);

  // Tab cooldown timer
  useEffect(() => {
    if (tabCooldown <= 0) return;
    const timer = setTimeout(() => setTabCooldown(tabCooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [tabCooldown]);

  // Reset recommended users and top post when selected node changes
  useEffect(() => {
    setRecommendedUsers([]);
    setTopPost(null);
    setPanelTab('info');
  }, [selectedNode?.id]);

  const handleSearch = (e) => {
    e.preventDefault();
    if (!searchQuery.trim() || !graphData || !sigmaRef.current) return;

    setSelectedFilterHashtag(null);

    const query = searchQuery.toLowerCase();
    const foundNode = graphData.nodes.find(
      (node) =>
        node.label.toLowerCase().includes(query) ||
        (node.displayName && node.displayName.toLowerCase().includes(query))
    );

    if (foundNode) {
      const graph = sigmaRef.current.getGraph();
      const nodeAttrs = graph.getNodeAttributes(foundNode.id);
      const camera = sigmaRef.current.getCamera();
      const bbox = sigmaRef.current.getBBox();

      // Convert graph coordinates to camera coordinates
      const width = bbox.x[1] - bbox.x[0];
      const height = bbox.y[1] - bbox.y[0];
      const normalizedX = (nodeAttrs.x - bbox.x[0]) / width;
      const normalizedY = (nodeAttrs.y - bbox.y[0]) / height;

      // Animate to node position with maximum zoom
      camera.animate(
        {
          x: normalizedX,
          y: normalizedY,
          ratio: 0.01,
        },
        { duration: 600 }
      );

      // Reset all nodes and edges to original colors
      graph.forEachNode(n => {
        graph.setNodeAttribute(n, 'color', '#f5d963');
      });
      graph.forEachEdge(e => {
        const edgeData = graph.getEdgeAttributes(e);
        graph.setEdgeAttribute(e, 'color', edgeData.mutual ? '#b0b0b0' : '#505050');
      });

      // Apply highlight for selected node
      nodeAttrs.id = foundNode.id;
      setSelectedNode(nodeAttrs);

      const neighbors = graph.neighbors(foundNode.id);
      const selectedNodeSet = new Set([foundNode.id, ...neighbors]);

      // Set selected node to cyan, grayscale unrelated nodes
      graph.forEachNode(n => {
        if (n === foundNode.id) {
          graph.setNodeAttribute(n, 'color', '#26C6DA'); // Cyan for selected node
        } else if (!selectedNodeSet.has(n)) {
          graph.setNodeAttribute(n, 'color', '#aaa');
        }
      });

      // Collect connected edges
      const connectedEdges = new Set();
      graph.forEachOutboundEdge(foundNode.id, e => {
        connectedEdges.add(e);
      });
      graph.forEachInboundEdge(foundNode.id, e => {
        connectedEdges.add(e);
      });

      // Make unrelated edges very dark
      graph.forEachEdge(e => {
        if (!connectedEdges.has(e)) {
          graph.setEdgeAttribute(e, 'color', '#222222');
        }
      });

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

  // Apply hashtag filter to graph
  useEffect(() => {
    if (!sigmaRef.current || !graphData) return;

    const graph = sigmaRef.current.getGraph();

    if (!selectedFilterHashtag) {
      // No filter: reset all nodes to original colors based on lastPostAt
      graph.forEachNode(n => {
        const nodeAttrs = graph.getNodeAttributes(n);
        let nodeColor = '#f5d963';
        if (nodeAttrs.lastPostAt) {
          const lastPostTime = new Date(nodeAttrs.lastPostAt);
          const now = new Date();
          const diffMs = now - lastPostTime;
          const diffHours = diffMs / (1000 * 60 * 60);
          if (diffHours <= 2) {
            nodeColor = '#ff6b4a';
          }
        }
        graph.setNodeAttribute(n, 'color', nodeColor);
      });
      // Reset edges
      graph.forEachEdge(e => {
        const edgeData = graph.getEdgeAttributes(e);
        graph.setEdgeAttribute(e, 'color', edgeData.mutual ? '#b0b0b0' : '#505050');
      });
    } else {
      // Filter active: grayscale nodes without the selected hashtag
      graph.forEachNode(n => {
        const nodeAttrs = graph.getNodeAttributes(n);
        const nodeHashtags = nodeAttrs.hashtags || [];
        const hasHashtag = nodeHashtags.includes(selectedFilterHashtag);

        if (hasHashtag) {
          // Node has the hashtag: show original color (yellow or orange-red)
          let nodeColor = '#f5d963';
          if (nodeAttrs.lastPostAt) {
            const lastPostTime = new Date(nodeAttrs.lastPostAt);
            const now = new Date();
            const diffMs = now - lastPostTime;
            const diffHours = diffMs / (1000 * 60 * 60);
            if (diffHours <= 2) {
              nodeColor = '#ff6b4a';
            }
          }
          graph.setNodeAttribute(n, 'color', nodeColor);
        } else {
          // Node doesn't have the hashtag: grayscale
          graph.setNodeAttribute(n, 'color', '#aaa');
        }
      });
    }
  }, [selectedFilterHashtag, graphData]);

  // Fetch available hashtags
  useEffect(() => {
    const fetchHashtags = async () => {
      try {
        const url = `https://${window.location.hostname}/sigma-graph/hashtags.json`;
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch hashtags');
        const data = await response.json();
        let tags = data.hashtags || [];
        setHashtags(tags);
        // Don't auto-select: wait for user to choose
      } catch (err) {
        console.error('Error fetching hashtags:', err);
        setError('Failed to fetch available hashtags');
      }
    };

    fetchHashtags();
  }, []);


  // Close modals and reset state when hashtag changes
  useEffect(() => {
    setShowStats(false);
    setShowInfo(false);
    setSelectedNode(null);
  }, [selectedHashtag]);

  // Fetch graph data when hashtag changes
  useEffect(() => {
    if (!selectedHashtag) return;

    const fetchGraphData = async () => {
      setLoading(true);
      setError(null);
      setGraphData(null);
      setSelectedNode(null);
      setSelectedFilterHashtag(null);

      try {
        if (!selectedHashtag) {
          throw new Error('Hashtag not selected');
        }
        const url = `https://${window.location.hostname}/sigma-graph/${encodeURIComponent(selectedHashtag)}/users_merged.json`;

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
        hashtags: node.hashtags || [],
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
      settings.scalingRatio = 1;  // Minimal scaling ratio
      settings.gravity = 10;  // Increase gravity for better node dispersion
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
        selectNodeAndHighlight(node, graph, sigma);
      });

      // Background click handler
      sigma.on('clickStage', () => {
        setSelectedNode(null);
        setSelectedFilterHashtag(null);

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

      // Auto-select node from URL parameter if handle is provided
      if (autoSelectHandle) {
        const foundNode = graphData.nodes.find(n => n.label === autoSelectHandle);
        if (foundNode) {
          selectNodeAndHighlight(foundNode.id, graph, sigma);
          setAutoSelectHandle(null);
        }
      }
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
          Sky Star Cluster <span style={{ fontSize: '0.65em', color: '#999', fontWeight: '400', verticalAlign: 'baseline', position: 'relative', top: '0.1em' }}>from BlueSky</span>
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
            <option value="">グラフ選択</option>
            {hashtags.map((tag) => {
              const label = tag.startsWith('unified_')
                ? `${tag.replace('unified_', '')} Network`
                : `#${tag}`;
              return (
                <option key={tag} value={tag}>
                  {label}
                </option>
              );
            })}
          </select>
          {selectedHashtag && (
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
          )}
          {selectedHashtag && (
            <button
              onClick={() => setShowStats(!showStats)}
              className="stats-btn"
              title="統計情報"
            >
              グラフ情報
            </button>
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
          {!selectedHashtag ? (
            <div className="loading">グラフを選択してください</div>
          ) : loading ? (
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
                <h2>Sky Star Cluster について</h2>
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

                <p><strong>ネットワークグラフについて</strong></p>
                <p>• 各ノード（円）がユーザーを表します。</p>
                <p>• ノードのサイズはフォロワー数に比例します。</p>
                <p>• エッジ（線）がフォロー関係を表します。</p>
                <p>• 濃い灰色の線は相互フォロー、薄い灰色は片方向フォローです。</p>
                <p>• 選択しているユーザーは水色で表示されます。</p>
                <p>• 直近で関連するポストをしているユーザーはオレンジ色で表示されます。</p>

                <p><strong>機能</strong></p>
                <p>• カテゴリを選択してグラフを切り替え</p>
                <p>• ハッシュタグを選択してグラフを絞り込み</p>
                <p>• 検索ボックスでユーザーを検索</p>
                <p>• ズームコントロールで拡大・縮小</p>
                <p>• ノードをクリックするとユーザー情報を表示</p>

                <p><strong>グラフ情報について</strong></p>
                <p>• ネットワーク内の影響力が強いユーザーのランキングが表示されます。</p>
                <p>• ランキングは、フォロー関係をベースにした独自計算式でスコアリングされます。</p>
                <p>• ハッシュタグを選択すると、ネットワークグラフのユーザーとエッジが絞り込まれます。</p>
                <p>• 統計情報は、各ネットワークグラフごとに計算されています。</p>

                <p><strong>推奨環境</strong></p>
                <p>• Google Chrome</p>
              </div>
              <div className="info-modal-footer">
                <hr style={{ margin: '0.5rem 0', border: 'none', borderTop: '1px solid #ccc' }} />
                <p style={{ fontSize: '0.9em', color: '#666' }}>created by <a href="https://bsky.app/profile/paseri-kurosawa.bsky.social" target="_blank" rel="noopener noreferrer">@paseri-kurosawa.bsky.social</a></p>
              </div>
            </div>
          </>
        )}

        {showStats && graphData && (
          <>
            <div className="modal-overlay" onClick={() => setShowStats(false)} />
            <div className="stats-modal" style={{ top: `${headerHeight}px`, maxHeight: `calc(100vh - ${headerHeight}px)` }}>
              <div className="stats-modal-header">
                <div className="stats-modal-tabs">
                  <button
                    className={`stats-tab ${statsTab === 'ranking' ? 'active' : ''}`}
                    onClick={() => setStatsTab('ranking')}
                  >
                    ランキング
                  </button>
                  <button
                    className={`stats-tab ${statsTab === 'hashtags' ? 'active' : ''}`}
                    onClick={() => setStatsTab('hashtags')}
                  >
                    ハッシュタグ
                  </button>
                  <button
                    className={`stats-tab ${statsTab === 'stats' ? 'active' : ''}`}
                    onClick={() => setStatsTab('stats')}
                  >
                    統計情報
                  </button>
                </div>
                <button
                  onClick={() => setShowStats(false)}
                  className="close-btn"
                >
                  ×
                </button>
              </div>
              <div className="stats-modal-content">
                {statsTab === 'ranking' && (
                  <>
                    {graphData.top_users && graphData.top_users.length > 0 ? (
                      graphData.top_users.slice(0, 100).map((user, index) => (
                        <div
                          key={user.id}
                          className={`ranking-card ${selectedNode?.id === user.id ? 'selected' : ''}`}
                          onClick={() => {
                            if (sigmaRef.current) {
                              const graph = sigmaRef.current.getGraph();
                              const nodeAttrs = graph.getNodeAttributes(user.id);
                              if (nodeAttrs) {
                                // Animate camera to node position
                                const camera = sigmaRef.current.getCamera();
                                const bbox = sigmaRef.current.getBBox();

                                const width = bbox.x[1] - bbox.x[0];
                                const height = bbox.y[1] - bbox.y[0];
                                const normalizedX = (nodeAttrs.x - bbox.x[0]) / width;
                                const normalizedY = (nodeAttrs.y - bbox.y[0]) / height;

                                camera.animate(
                                  {
                                    x: normalizedX,
                                    y: normalizedY,
                                    ratio: 0.01,
                                  },
                                  { duration: 600 }
                                );

                                // Reset all nodes and edges to original colors
                                graph.forEachNode(n => {
                                  graph.setNodeAttribute(n, 'color', '#f5d963');
                                });
                                graph.forEachEdge(e => {
                                  const edgeData = graph.getEdgeAttributes(e);
                                  graph.setEdgeAttribute(e, 'color', edgeData.mutual ? '#b0b0b0' : '#505050');
                                });

                                // Apply highlight for selected node
                                nodeAttrs.id = user.id;
                                setSelectedNode(nodeAttrs);

                                const neighbors = graph.neighbors(user.id);
                                const selectedNodeSet = new Set([user.id, ...neighbors]);

                                // Set selected node to cyan
                                graph.setNodeAttribute(user.id, 'color', '#26C6DA');

                                // Grayscale unrelated nodes
                                graph.forEachNode(n => {
                                  if (!selectedNodeSet.has(n)) {
                                    graph.setNodeAttribute(n, 'color', '#aaa');
                                  }
                                });

                                // Collect and highlight connected edges
                                const connectedEdges = new Set();
                                graph.forEachOutboundEdge(user.id, e => {
                                  connectedEdges.add(e);
                                });
                                graph.forEachInboundEdge(user.id, e => {
                                  connectedEdges.add(e);
                                });

                                graph.forEachEdge(e => {
                                  if (!connectedEdges.has(e)) {
                                    graph.setEdgeAttribute(e, 'color', '#222222');
                                  }
                                });
                              }
                            }
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          <div className="ranking-badge">{index + 1}位</div>
                          <div className="ranking-card-header">
                            {user.avatar && (
                              <img src={user.avatar} alt="" className="ranking-card-avatar" />
                            )}
                            <div className="ranking-card-title">{user.displayName || 'N/A'}</div>
                          </div>
                          <div className="ranking-card-stats">
                            <span>スコア: <strong>{user.score}</strong></span>
                            <span>エッジ: <strong>{user.stats.one_way_followers + user.stats.mutual_followers}</strong></span>
                            <span>投稿: <strong>{user.stats.posts_count}</strong></span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="no-hashtags-message">ランキングデータがありません</div>
                    )}
                  </>
                )}
                {statsTab === 'hashtags' && (
                  <div className="hashtags-filter-container">
                    {selectedFilterHashtag && (
                      <div className="filter-status">
                        <span className="filter-active-label">
                          フィルター適用中: #{selectedFilterHashtag}
                        </span>
                        <button
                          className="filter-clear-btn"
                          onClick={() => setSelectedFilterHashtag(null)}
                        >
                          解除
                        </button>
                      </div>
                    )}

                    <div className="hashtags-list">
                      {!graphData?.metadata?.hashtags || graphData.metadata.hashtags.length === 0 ? (
                        <div className="no-hashtags-message">
                          ハッシュタグがありません
                        </div>
                      ) : (
                        graphData.metadata.hashtags.map(({ tag, nodeCount }) => (
                          <div
                            key={tag}
                            className={`hashtag-filter-item ${selectedFilterHashtag === tag ? 'selected' : ''}`}
                            onClick={() => {
                              if (selectedFilterHashtag === tag) {
                                setSelectedFilterHashtag(null);
                              } else {
                                setSelectedFilterHashtag(tag);
                              }
                            }}
                          >
                            <span className="hashtag-filter-name">
                              #{tag}
                            </span>
                            <span className="hashtag-filter-count">
                              {nodeCount} ノード
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
                {statsTab === 'stats' && (
                  <div className="stats-info-container">
                    <div className="stats-info-item">
                      <div className="stats-info-label">ノード数</div>
                      <div className="stats-info-value">{graphData.metadata?.nodeCount || 'N/A'}</div>
                    </div>
                    <div className="stats-info-item">
                      <div className="stats-info-label">エッジ数</div>
                      <div className="stats-info-value">{graphData.metadata?.edgeCount || 'N/A'}</div>
                    </div>
                    <div className="stats-info-item">
                      <div className="stats-info-label">ネットワーク密度</div>
                      <div className="stats-info-value">{graphData.metadata?.density ? (graphData.metadata.density * 100).toFixed(4) + '%' : 'N/A'}</div>
                    </div>
                    <div className="stats-info-item">
                      <div className="stats-info-label">平均次数</div>
                      <div className="stats-info-value">{graphData.metadata?.averageDegree || 'N/A'}</div>
                    </div>
                    <div className="stats-info-item">
                      <div className="stats-info-label">最終更新</div>
                      <div className="stats-info-value">{graphData.metadata?.timestamp ? new Date(graphData.metadata.timestamp).toLocaleDateString('ja-JP') + ' ' + new Date(graphData.metadata.timestamp).toLocaleTimeString('ja-JP') : 'N/A'}</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {selectedNode && (
          <div
            className="user-panel"
            style={{
              left: `${panelPos.x}px`,
              top: `${panelPos.y}px`
            }}
          >
            {/* Draggable header */}
            <div
              style={{
                padding: '0.6rem',
                borderBottom: '1px solid #eee',
                marginLeft: '-0.6rem',
                marginRight: '-0.6rem',
                marginTop: '-0.6rem',
                marginBottom: '0',
                cursor: isDragging ? 'grabbing' : 'grab',
                backgroundColor: '#f9f9f9',
                borderRadius: '8px 8px 0 0',
                textAlign: 'center',
                fontSize: '0.7rem',
                color: '#999',
                userSelect: 'none',
                touchAction: 'none'
              }}
              onMouseDown={handlePanelMouseDown}
              onTouchStart={handlePanelTouchStart}
            >
              ≡
            </div>

            {/* Tab buttons */}
            <div
              style={{ display: 'flex', gap: '0', borderBottom: '1px solid #eee', marginBottom: '0.6rem', marginLeft: '-0.6rem', marginRight: '-0.6rem', marginTop: '0', paddingLeft: '0.6rem', paddingRight: '0.6rem' }}
            >
              <button
                onClick={() => setPanelTab('info')}
                style={{
                  flex: 1,
                  padding: '0.6rem 0.1rem',
                  border: 'none',
                  background: panelTab === 'info' ? 'white' : '#f9f9f9',
                  color: panelTab === 'info' ? '#1da1f2' : '#666',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'center',
                  borderRight: '1px solid #eee',
                  borderBottom: panelTab === 'info' ? '2px solid #1da1f2' : 'none',
                  marginBottom: panelTab === 'info' ? '-1px' : '0',
                  transition: 'all 0.2s'
                }}
              >
                ユーザー情報
              </button>
              <button
                onClick={() => {
                  if (recommendedUsers.length === 0) {
                    const recommended = calculateRecommendedUsers(selectedNode.id);
                    setRecommendedUsers(recommended);
                  }
                  setPanelTab('recommended');
                }}
                style={{
                  flex: 1,
                  padding: '0.6rem 0.1rem',
                  border: 'none',
                  background: panelTab === 'recommended' ? 'white' : '#f9f9f9',
                  color: panelTab === 'recommended' ? '#1da1f2' : '#666',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'center',
                  borderRight: '1px solid #eee',
                  borderBottom: panelTab === 'recommended' ? '2px solid #1da1f2' : 'none',
                  marginBottom: panelTab === 'recommended' ? '-1px' : '0',
                  transition: 'all 0.2s'
                }}
              >
                近いユーザー
              </button>
              <button
                onClick={() => {
                  if (topPost === null && !topPostLoading) {
                    handleFetchTopPost(selectedNode.accountId);
                  }
                  setPanelTab('toppost');
                }}
                disabled={tabCooldown > 0}
                style={{
                  flex: 1,
                  padding: '0.6rem 0.1rem',
                  border: 'none',
                  background: panelTab === 'toppost' ? 'white' : '#f9f9f9',
                  color: panelTab === 'toppost' ? '#1da1f2' : '#666',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  cursor: tabCooldown > 0 ? 'not-allowed' : 'pointer',
                  textAlign: 'center',
                  borderBottom: panelTab === 'toppost' ? '2px solid #1da1f2' : 'none',
                  marginBottom: panelTab === 'toppost' ? '-1px' : '0',
                  transition: 'all 0.2s',
                  opacity: tabCooldown > 0 ? 0.5 : 1
                }}
              >
                {topPostLoading ? '読込中...' : 'トップポスト'}
              </button>
              <button
                onClick={() => setPanelTab('share')}
                style={{
                  flex: 1,
                  padding: '0.6rem 0.1rem',
                  border: 'none',
                  background: panelTab === 'share' ? 'white' : '#f9f9f9',
                  color: panelTab === 'share' ? '#1da1f2' : '#666',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  textAlign: 'center',
                  borderBottom: panelTab === 'share' ? '2px solid #1da1f2' : 'none',
                  marginBottom: panelTab === 'share' ? '-1px' : '0',
                  transition: 'all 0.2s',
                  borderRight: 'none'
                }}
              >
                シェア
              </button>
            </div>

            {/* Info Tab */}
            {panelTab === 'info' && (
              <>
                {selectedNode.avatar && (
                  <div
                    className="avatar-container"
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      if (selectedNode.id) {
                        selectNodeAndHighlight(selectedNode.id);
                      }
                    }}
                  >
                    <img key={selectedNode.label} src={selectedNode.avatar} alt="" className="user-avatar" />
                  </div>
                )}
                <div
                  className="info-item"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    if (sigmaRef.current && selectedNode.id) {
                      const graph = sigmaRef.current.getGraph();
                      const nodeAttrs = graph.getNodeAttributes(selectedNode.id);
                      if (nodeAttrs) {
                        const camera = sigmaRef.current.getCamera();
                        const bbox = sigmaRef.current.getBBox();

                        const width = bbox.x[1] - bbox.x[0];
                        const height = bbox.y[1] - bbox.y[0];
                        const normalizedX = (nodeAttrs.x - bbox.x[0]) / width;
                        const normalizedY = (nodeAttrs.y - bbox.y[0]) / height;

                        camera.animate(
                          {
                            x: normalizedX,
                            y: normalizedY,
                            ratio: 0.01,
                          },
                          { duration: 600 }
                        );
                      }
                    }
                  }}
                >
                  <div className="info-value display-name">{selectedNode.displayName || 'N/A'}</div>
                </div>
                <div className="info-item">
                  <a href={`https://bsky.app/profile/${selectedNode.accountId}`} target="_blank" rel="noopener noreferrer" className="profile-link" style={{ display: 'inline' }}>
                    {selectedNode.accountId}
                  </a>
                </div>
                <div className="stats-row">
                  <span>フォロー: <strong>{selectedNode.followsCount || 0}</strong></span>
                  <span>フォロワー: <strong>{selectedNode.followersCount || 0}</strong></span>
                  <span>投稿数: <strong>{selectedNode.postsCount || 0}</strong></span>
                </div>
                {selectedNode.hashtags && selectedNode.hashtags.length > 0 && (
                  <div className="stats-row">
                    <span style={{ fontSize: '0.65rem', color: '#666' }}>
                      ハッシュタグ: <strong>
                        {selectedNode.hashtags.map((tag, idx) => (
                          <div key={idx}>{tag.startsWith('#') ? tag : `#${tag}`}</div>
                        ))}
                      </strong>
                    </span>
                  </div>
                )}
                {graphData?.top_users && (
                  <div className="stats-row" style={{ paddingBottom: '0.6rem' }}>
                    {(() => {
                      const rank = graphData.top_users.findIndex(u => u.id === selectedNode.id);
                      return rank >= 0 ? (
                        <span>ネットワーク影響度: <strong>{rank + 1}位</strong></span>
                      ) : null;
                    })()}
                  </div>
                )}
              </>
            )}

            {/* Top Post Tab */}
            {panelTab === 'toppost' && (
              <>
                {topPostLoading ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: '#666', fontSize: '0.7rem' }}>
                    トップポストを読み込み中...
                  </div>
                ) : topPost?.error ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: '#666', fontSize: '0.7rem' }}>
                    ポストが見つかりません
                  </div>
                ) : topPost ? (
                  <div style={{
                    padding: '0.8rem',
                    backgroundColor: '#f9f9f9',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.6rem'
                  }}>
                    <div style={{
                      display: 'flex',
                      gap: '0.6rem',
                      alignItems: 'flex-start'
                    }}>
                      {topPost.author?.avatar && (
                        <img
                          src={topPost.author.avatar}
                          alt=""
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '50%',
                            objectFit: 'cover',
                            flexShrink: 0
                          }}
                        />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 'bold', color: '#333' }}>
                          {topPost.author?.displayName || 'N/A'}
                        </div>
                        <a
                          href={`https://bsky.app/profile/${topPost.author?.handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: '#1da1f2',
                            textDecoration: 'none',
                            fontSize: '0.7rem'
                          }}
                        >
                          @{topPost.author?.handle}
                        </a>
                      </div>
                    </div>
                    <div style={{
                      lineHeight: '1.4',
                      color: '#333',
                      wordBreak: 'break-word',
                      maxHeight: '150px',
                      overflow: 'hidden',
                      fontSize: '0.75rem',
                      paddingRight: '0.8rem'
                    }}>
                      {topPost.record?.text}
                    </div>
                    <div style={{
                      display: 'flex',
                      gap: '1rem',
                      fontSize: '0.7rem',
                      color: '#666'
                    }}>
                      <span>❤️ {topPost.likeCount || 0}</span>
                      <span>💬 {topPost.replyCount || 0}</span>
                      <span>🔄 {topPost.repostCount || 0}</span>
                      {topPost.hasImages && <span>🖼️</span>}
                    </div>
                    <a
                      href={`https://bsky.app/profile/${topPost.author?.handle}/post/${topPost.uri?.split('/').pop()}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: '#1da1f2',
                        textDecoration: 'none',
                        fontSize: '0.7rem'
                      }}
                    >
                      Blueskyで見る →
                    </a>
                  </div>
                ) : (
                  <div style={{ padding: '1rem', textAlign: 'center', color: '#666', fontSize: '0.7rem' }}>
                    トップポストを取得するには、このタブをクリック
                  </div>
                )}
              </>
            )}

            {/* Recommended Tab */}
            {panelTab === 'recommended' && (
              <>
                {recommendedUsers.length === 0 ? (
                  <div style={{ padding: '1rem', textAlign: 'center', color: '#666', fontSize: '0.7rem' }}>
                    おすすめユーザーが見つかりません
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {recommendedUsers.map(user => (
                      <div
                        key={user.id}
                        style={{
                          padding: '0.6rem',
                          backgroundColor: '#f9f9f9',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          display: 'flex',
                          gap: '0.4rem',
                          alignItems: 'flex-start'
                        }}
                      >
                        {user.avatar && (
                          <img
                            src={user.avatar}
                            alt=""
                            style={{
                              width: '40px',
                              height: '40px',
                              borderRadius: '50%',
                              objectFit: 'cover',
                              flexShrink: 0,
                              cursor: 'pointer'
                            }}
                            onClick={() => {
                              selectNodeAndHighlight(user.id);
                            }}
                          />
                        )}
                        <div>
                          <div
                            style={{
                              fontWeight: 'bold',
                              color: '#333',
                              cursor: 'pointer',
                              wordBreak: 'break-word',
                              marginBottom: '0.15rem',
                              width: 'fit-content'
                            }}
                            onClick={() => {
                              selectNodeAndHighlight(user.id);
                            }}
                          >
                            {user.displayName}
                          </div>
                          <a
                            href={`https://bsky.app/profile/${user.accountId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              color: '#1da1f2',
                              textDecoration: 'none',
                              fontSize: '0.7rem',
                              display: 'inline'
                            }}
                          >
                            {user.accountId}
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Share Tab */}
            {panelTab === 'share' && (
              <div style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                {selectedNode && graphData && selectedHashtag && (() => {
                  // Get ranking position (search by id)
                  const rankIndex = graphData.top_users.findIndex(u => u.id === selectedNode.id);
                  const rank = rankIndex >= 0 ? rankIndex + 1 : 'N/A';

                  // Get graph name (convert unified_vtuber to "vtuber Network")
                  const graphName = selectedHashtag.startsWith('unified_')
                    ? `${selectedHashtag.replace('unified_', '')} Network`
                    : `#${selectedHashtag}`;

                  // Generate share URL
                  const shareUrl = `https://d1g3djqpjf3j38.cloudfront.net/?handle=${selectedNode.accountId}&network=${selectedHashtag}`;

                  // Generate share text
                  const today = new Date();
                  const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')} ${String(today.getHours()).padStart(2, '0')}:${String(today.getMinutes()).padStart(2, '0')}:${String(today.getSeconds()).padStart(2, '0')}`;
                  const shareText = `${selectedNode.displayName}さんの${graphName} Rank：${rank}位 (${dateStr})\n${shareUrl}\nGenerated by #SkyStarCluster`;

                  return (
                    <div>
                      <div style={{
                        padding: '0.8rem',
                        backgroundColor: '#f9f9f9',
                        borderRadius: '4px',
                        fontSize: '0.7rem',
                        lineHeight: '1.4',
                        color: '#333',
                        wordBreak: 'break-word',
                        maxHeight: '120px',
                        overflow: 'auto'
                      }}>
                        {shareText}
                      </div>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(shareText);
                          alert('クリップボードにコピーしました');
                        }}
                        style={{
                          padding: '0.6rem 1rem',
                          background: '#ff6b4a',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          fontSize: '0.75rem',
                          fontWeight: 500,
                          cursor: 'pointer',
                          width: '100%'
                        }}
                      >
                        コピー
                      </button>
                      <button
                        onClick={async () => {
                          setShareImageLoading(true);
                          try {
                            // Format snapshot timestamp: yyyy/mm/dd hh:mm:ss
                            const generatedAt = graphData?.metadata?.timestamp || graphData?.metadata?.generatedAt;
                            let snapshotTime = '';
                            if (generatedAt) {
                              const dt = new Date(generatedAt);
                              const yyyy = dt.getFullYear();
                              const mm = String(dt.getMonth() + 1).padStart(2, '0');
                              const dd = String(dt.getDate()).padStart(2, '0');
                              const hh = String(dt.getHours()).padStart(2, '0');
                              const min = String(dt.getMinutes()).padStart(2, '0');
                              const ss = String(dt.getSeconds()).padStart(2, '0');
                              snapshotTime = `${yyyy}/${mm}/${dd} ${hh}:${min}:${ss}`;
                            }

                            const params = new URLSearchParams({
                              displayName: selectedNode.displayName || 'Unknown',
                              avatarUrl: selectedNode.avatar || '',
                              followerCount: String(selectedNode.followersCount || 0),
                              followsCount: String(selectedNode.followsCount || 0),
                              postsCount: String(selectedNode.postsCount || 0),
                              rank: String(rank || 'N/A'),
                              graphName: graphName || 'Network',
                              snapshotTime: snapshotTime || 'Unknown'
                            });

                            // Debug log
                            console.log('[SHARE IMAGE] Selected Node:', selectedNode);
                            console.log('[SHARE IMAGE] Params:', {
                              displayName: selectedNode.displayName,
                              followersCount: selectedNode.followersCount,
                              followsCount: selectedNode.followsCount,
                              postsCount: selectedNode.postsCount,
                              snapshotTime: snapshotTime
                            });

                            const apiUrl = `${apiEndpoint}/api/user/${selectedNode.accountId}/share-image?${params.toString()}`;

                            // Fetch base64 image
                            const response = await fetch(apiUrl);
                            const base64Data = await response.text();

                            // Convert base64 to Blob
                            const binaryString = atob(base64Data);
                            const bytes = new Uint8Array(binaryString.length);
                            for (let i = 0; i < binaryString.length; i++) {
                              bytes[i] = binaryString.charCodeAt(i);
                            }
                            const blob = new Blob([bytes], { type: 'image/png' });

                            // Create File object
                            const file = new File([blob], `${selectedNode.displayName}-rank${rank}.png`, {
                              type: 'image/png'
                            });

                            // Share via Web Share API
                            if (navigator.share) {
                              const bskyProfileUrl = `https://bsky.app/profile/${selectedNode.accountId}`;
                              const shareText = `${bskyProfileUrl}\n${shareUrl}\nGenerated by #SkyStarCluster`;
                              await navigator.share({
                                title: selectedNode.displayName,
                                text: shareText,
                                files: [file]
                              });
                            } else {
                              // Fallback: download
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = `${selectedNode.displayName}-rank${rank}.png`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }
                          } catch (error) {
                            console.error('画像生成エラー:', error);
                            alert('画像生成に失敗しました。タイムアウトの可能性があります。もう一度お試しください。');
                          } finally {
                            setShareImageLoading(false);
                          }
                        }}
                        disabled={shareImageLoading}
                        style={{
                          padding: '0.05rem 0.1rem',
                          background: 'transparent',
                          color: '#d0d0d0',
                          border: '1px solid #e8e8e8',
                          borderRadius: '1px',
                          fontSize: '0.35rem',
                          fontWeight: 300,
                          cursor: shareImageLoading ? 'not-allowed' : 'pointer',
                          marginTop: '0.1rem',
                          opacity: shareImageLoading ? 0.5 : 0.3
                        }}
                      >
                        画像生成
                      </button>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Draggable footer */}
            <div
              style={{
                padding: '0.6rem',
                borderTop: '1px solid #eee',
                marginLeft: '-0.6rem',
                marginRight: '-0.6rem',
                marginBottom: '-0.6rem',
                cursor: isDragging ? 'grabbing' : 'grab',
                backgroundColor: '#f9f9f9',
                borderRadius: '0 0 8px 8px',
                textAlign: 'center',
                fontSize: '0.7rem',
                color: '#999',
                userSelect: 'none',
                touchAction: 'none'
              }}
              onMouseDown={handlePanelMouseDown}
              onTouchStart={handlePanelTouchStart}
            >
              ≡
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
