#!/usr/bin/env node
/**
 * GID MCP Server
 *
 * Model Context Protocol server for Graph-Indexed Development.
 * Exposes GID functionality to AI assistants.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import * as path from 'node:path';
import {
  loadGraph,
  loadGraphWithValidation,
  initGraph,
  saveGraph,
  graphToYaml,
  findGraphFile,
  GIDGraph,
  QueryEngine,
  Validator,
  GraphSummary,
  GIDError,
  createStateManager,
  diffGraphs,
} from './core/index.js';
import { extractTypeScript, previewExtraction, groupIntoComponents } from './extractors/index.js';
import {
  getFileSignatures,
  detectFilePatterns,
  prepareFileSummary,
  getFunctionDetails,
  getClassDetails,
  searchCodePattern,
} from './analyzers/index.js';
import { gatherSemanticContext, buildSemanticPrompt } from './core/semantic-context.js';
// License checks removed - will use remote MCP with usage limits instead

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Definitions
// ═══════════════════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    name: 'gid_query_impact',
    description: 'Analyze what components and features are affected by changing a node',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node: { type: 'string', description: 'Node name to analyze' },
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
      },
      required: ['node'],
    },
  },
  {
    name: 'gid_query_deps',
    description: 'Get dependencies or dependents of a node',
    inputSchema: {
      type: 'object' as const,
      properties: {
        node: { type: 'string', description: 'Node name' },
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
        reverse: { type: 'boolean', description: 'If true, get dependents instead of dependencies' },
        depth: { type: 'number', description: 'Max depth (default: 1, -1 for unlimited)' },
      },
      required: ['node'],
    },
  },
  {
    name: 'gid_query_common_cause',
    description: 'Find shared dependencies between two nodes (useful for debugging)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        nodeA: { type: 'string', description: 'First node' },
        nodeB: { type: 'string', description: 'Second node' },
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
      },
      required: ['nodeA', 'nodeB'],
    },
  },
  {
    name: 'gid_query_path',
    description: 'Find dependency path between two nodes',
    inputSchema: {
      type: 'object' as const,
      properties: {
        from: { type: 'string', description: 'Starting node' },
        to: { type: 'string', description: 'Target node' },
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'gid_design',
    description: 'Generate semantic graph from natural language requirements. Creates Features, Components, layers, and relationships.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        requirements: { type: 'string', description: 'Natural language description of what to build' },
        outputPath: { type: 'string', description: 'Where to save graph.yml (optional)' },
      },
      required: ['requirements'],
    },
  },
  {
    name: 'gid_read',
    description: 'Read and return the current graph structure or summary',
    inputSchema: {
      type: 'object' as const,
      properties: {
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
        format: {
          type: 'string',
          enum: ['yaml', 'json', 'summary'],
          description: 'Output format (default: summary)',
        },
      },
    },
  },
  {
    name: 'gid_init',
    description: 'Initialize a new GID graph in a project',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Project directory (default: current)' },
        template: {
          type: 'string',
          enum: ['minimal', 'standard'],
          description: 'Template to use (default: standard)',
        },
        force: { type: 'boolean', description: 'Overwrite existing graph' },
      },
    },
  },
  {
    name: 'gid_extract',
    description: 'Extract dependency graph from existing code (TypeScript/JavaScript) with optional enrichment',
    inputSchema: {
      type: 'object' as const,
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Directories to scan (default: current directory)',
        },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional patterns to ignore',
        },
        outputPath: { type: 'string', description: 'Where to save graph.yml' },
        dryRun: { type: 'boolean', description: 'Preview without writing' },
        withSignatures: { type: 'boolean', description: 'Include function/class signatures in node metadata' },
        withPatterns: { type: 'boolean', description: 'Detect and include architectural patterns (controller, service, etc.)' },
        enrich: { type: 'boolean', description: 'Shorthand for withSignatures + withPatterns' },
        group: { type: 'boolean', description: 'Group files into components by directory structure (auto-detects optimal grouping)' },
        groupingDepth: { type: 'number', description: 'Directory depth for grouping (default: auto-detect)' },
      },
    },
  },
  {
    name: 'gid_history',
    description: 'Manage graph version history (list, diff, restore)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
        action: {
          type: 'string',
          enum: ['list', 'diff', 'restore'],
          description: 'Action to perform (default: list)',
        },
        version: { type: 'string', description: 'Version filename for diff/restore' },
        force: { type: 'boolean', description: 'Force restore without confirmation' },
      },
    },
  },
  {
    name: 'gid_get_schema',
    description: 'Get the GID graph schema and examples for designing graphs',
    inputSchema: {
      type: 'object' as const,
      properties: {
        includeExample: { type: 'boolean', description: 'Include example graph (default: true)' },
      },
    },
  },
  {
    name: 'gid_analyze',
    description: 'Analyze file, function, or class. Returns structured JSON for AI consumption.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: { type: 'string', description: 'Path to the file to analyze' },
        function: { type: 'string', description: 'Function name for deep dive (optional)' },
        class: { type: 'string', description: 'Class name for deep dive (optional)' },
        includePatterns: { type: 'boolean', description: 'Include pattern detection (default: true)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'gid_advise',
    description: 'Validate graph and get improvement suggestions. Returns health score + issues + suggestions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
        level: {
          type: 'string',
          enum: ['deterministic', 'heuristic', 'all'],
          description: 'Suggestion level (default: all)',
        },
        threshold: { type: 'number', description: 'Coupling threshold (default: 5)' },
      },
    },
  },
  {
    name: 'gid_refactor',
    description: 'Preview or apply graph changes to codebase (rename, move, split, merge nodes)',
    inputSchema: {
      type: 'object' as const,
      properties: {
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
        operation: {
          type: 'string',
          enum: ['preview', 'rename', 'move', 'delete'],
          description: 'Refactoring operation',
        },
        nodeId: { type: 'string', description: 'Node to refactor' },
        newName: { type: 'string', description: 'New name for rename operation' },
        newLayer: { type: 'string', description: 'New layer for move operation' },
        dryRun: { type: 'boolean', description: 'Preview changes without applying (default: true)' },
      },
      required: ['operation', 'nodeId'],
    },
  },
  {
    name: 'gid_semantify',
    description: 'Propose semantic upgrades: map files to components, assign layers, detect features. Use returnContext: true for AI semantic analysis (reads docs + code names).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
        scope: {
          type: 'string',
          enum: ['layers', 'components', 'features', 'all'],
          description: 'What to semantify (default: all)',
        },
        dryRun: { type: 'boolean', description: 'Preview proposals without applying (default: true)' },
        returnContext: {
          type: 'boolean',
          description: 'Return rich semantic context (docs + code) for AI analysis instead of heuristic proposals',
        },
      },
    },
  },
  {
    name: 'gid_get_file_summary',
    description: 'Get structured file analysis ready for AI to generate a summary description',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: { type: 'string', description: 'Path to the file to summarize' },
        includeContent: { type: 'boolean', description: 'Include full file content (default: false)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'gid_edit_graph',
    description: 'Directly add, update, or delete nodes and edges in the graph',
    inputSchema: {
      type: 'object' as const,
      properties: {
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['add_node', 'update_node', 'delete_node', 'add_edge', 'delete_edge'],
                description: 'Operation to perform',
              },
              nodeId: { type: 'string', description: 'Node ID (for node operations)' },
              node: {
                type: 'object',
                description: 'Node data (for add_node/update_node)',
                properties: {
                  type: { type: 'string', enum: ['Feature', 'Component', 'Interface', 'Data', 'File', 'Test', 'Decision'] },
                  description: { type: 'string' },
                  layer: { type: 'string', enum: ['interface', 'application', 'domain', 'infrastructure'] },
                  status: { type: 'string', enum: ['draft', 'in_progress', 'active', 'deprecated'] },
                  priority: { type: 'string', enum: ['core', 'supporting', 'generic'] },
                  path: { type: 'string' },
                },
              },
              edge: {
                type: 'object',
                description: 'Edge data (for add_edge/delete_edge)',
                properties: {
                  from: { type: 'string' },
                  to: { type: 'string' },
                  relation: { type: 'string', enum: ['implements', 'depends_on', 'calls', 'reads', 'writes', 'tested_by', 'defined_in', 'decided_by'] },
                },
              },
            },
            required: ['action'],
          },
          description: 'List of operations to perform',
        },
        dryRun: { type: 'boolean', description: 'Preview changes without applying (default: false)' },
      },
      required: ['operations'],
    },
  },
  {
    name: 'gid_visual',
    description: 'Generate static HTML visualization of the dependency graph. Returns self-contained HTML that can be saved and opened in a browser.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        graphPath: { type: 'string', description: 'Path to graph.yml (optional)' },
        outputPath: { type: 'string', description: 'Path to save the HTML file (optional, returns HTML content if not specified)' },
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Resource Definitions
// ═══════════════════════════════════════════════════════════════════════════════

const RESOURCES = [
  {
    uri: 'gid://graph',
    name: 'Current Graph',
    description: 'The current project dependency graph',
    mimeType: 'text/yaml',
  },
  {
    uri: 'gid://health',
    name: 'Health Status',
    description: 'Current health score and issues',
    mimeType: 'application/json',
  },
  {
    uri: 'gid://features',
    name: 'Feature List',
    description: 'List of all features in the graph',
    mimeType: 'application/json',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Tool Handlers
// ═══════════════════════════════════════════════════════════════════════════════

async function handleQueryImpact(args: { node: string; graphPath?: string }) {
  const graphData = loadGraph(args.graphPath);
  const graph = new GIDGraph(graphData);
  const engine = new QueryEngine(graph);

  const result = engine.getImpact(args.node);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

async function handleQueryDeps(args: {
  node: string;
  graphPath?: string;
  reverse?: boolean;
  depth?: number;
}) {
  const graphData = loadGraph(args.graphPath);
  const graph = new GIDGraph(graphData);
  const engine = new QueryEngine(graph);

  const depth = args.depth ?? 1;
  const result = args.reverse
    ? engine.getDependents(args.node, depth)
    : engine.getDependencies(args.node, depth);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

async function handleQueryCommonCause(args: {
  nodeA: string;
  nodeB: string;
  graphPath?: string;
}) {
  const graphData = loadGraph(args.graphPath);
  const graph = new GIDGraph(graphData);
  const engine = new QueryEngine(graph);

  const result = engine.getCommonCause(args.nodeA, args.nodeB);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

async function handleQueryPath(args: { from: string; to: string; graphPath?: string }) {
  const graphData = loadGraph(args.graphPath);
  const graph = new GIDGraph(graphData);
  const engine = new QueryEngine(graph);

  const result = engine.findPath(args.from, args.to);

  if (!result) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            from: args.from,
            to: args.to,
            path: null,
            message: `No path found from "${args.from}" to "${args.to}"`,
          }, null, 2),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

async function handleDesign(args: { requirements: string; outputPath?: string }) {
  // Parse requirements to extract potential features and components
  const requirements = args.requirements.toLowerCase();

  // Extract keywords to suggest structure
  const featureKeywords = ['login', 'register', 'auth', 'payment', 'checkout', 'search', 'notification', 'upload', 'download', 'report', 'dashboard', 'profile', 'settings'];
  const componentKeywords = ['service', 'controller', 'repository', 'api', 'database', 'cache', 'queue', 'email', 'sms', 'storage'];

  const suggestedFeatures: string[] = [];
  const suggestedComponents: string[] = [];

  for (const keyword of featureKeywords) {
    if (requirements.includes(keyword)) {
      suggestedFeatures.push(keyword.charAt(0).toUpperCase() + keyword.slice(1));
    }
  }

  for (const keyword of componentKeywords) {
    if (requirements.includes(keyword)) {
      suggestedComponents.push(keyword.charAt(0).toUpperCase() + keyword.slice(1) + 'Service');
    }
  }

  // Generate a template graph structure
  const graphTemplate = {
    nodes: {} as Record<string, object>,
    edges: [] as Array<{ from: string; to: string; relation: string }>,
  };

  // Add suggested features
  for (const feature of suggestedFeatures) {
    graphTemplate.nodes[feature] = {
      type: 'Feature',
      description: `${feature} functionality`,
      priority: 'supporting',
    };
  }

  // Add suggested components
  for (const component of suggestedComponents) {
    graphTemplate.nodes[component] = {
      type: 'Component',
      layer: 'application',
      description: `Handles ${component.replace('Service', '').toLowerCase()} logic`,
    };
  }

  // Generate edges (components implement features)
  for (const feature of suggestedFeatures) {
    for (const component of suggestedComponents) {
      if (component.toLowerCase().includes(feature.toLowerCase().slice(0, 4))) {
        graphTemplate.edges.push({
          from: component,
          to: feature,
          relation: 'implements',
        });
      }
    }
  }

  const result = {
    requirements: args.requirements,
    suggestedFeatures,
    suggestedComponents,
    graphTemplate,
    instructions: `
This is a starting template based on keywords in your requirements.
To generate a more complete graph:

1. Use gid_get_schema to understand the full graph structure
2. Expand this template with:
   - More specific Features based on business capabilities
   - Components organized by layer (interface, application, domain, infrastructure)
   - Proper edges: implements, depends_on, tested_by, etc.
3. Use gid_init to create the graph, then gid_edit_graph to build it out

For AI-powered graph generation, the AI assistant can:
1. Analyze the requirements more deeply
2. Generate a complete graph.yml structure
3. Use gid_edit_graph to create it
    `.trim(),
  };

  // If outputPath provided, save the template
  if (args.outputPath) {
    const yaml = graphToYaml(graphTemplate as unknown as ReturnType<typeof loadGraph>);
    const fs = await import('fs');
    fs.writeFileSync(args.outputPath, yaml, 'utf-8');

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ...result,
            saved: true,
            outputPath: args.outputPath,
          }, null, 2),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

async function handleRead(args: { graphPath?: string; format?: string }) {
  const graphPath = args.graphPath ?? findGraphFile();
  const format = args.format ?? 'summary';

  if (!graphPath) {
    throw new McpError(ErrorCode.InvalidRequest, 'No graph.yml found');
  }

  const graphData = loadGraph(graphPath);
  const graph = new GIDGraph(graphData);

  if (format === 'yaml') {
    return {
      content: [
        {
          type: 'text' as const,
          text: graphToYaml(graphData),
        },
      ],
    };
  }

  if (format === 'json') {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(graphData, null, 2),
        },
      ],
    };
  }

  // Summary format
  const stats = graph.getStats();
  const validator = new Validator();
  const validation = validator.validate(graph);
  const features = graph.getFeatures().map(([id]) => id);

  const summary: GraphSummary = {
    path: graphPath,
    stats: {
      totalNodes: stats.nodeCount,
      features: stats.featureCount,
      components: stats.componentCount,
      interfaces: stats.interfaceCount,
      data: stats.dataCount,
      files: stats.fileCount,
      tests: stats.testCount,
      totalEdges: stats.edgeCount,
    },
    healthScore: validation.healthScore,
    features,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(summary, null, 2),
      },
    ],
  };
}

async function handleInit(args: { path?: string; template?: string; force?: boolean }) {
  try {
    const graphPath = initGraph(args.path ?? process.cwd(), args.force ?? false);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            created: true,
            graphPath,
            template: args.template ?? 'standard',
            message: 'Graph initialized. Add your features and components to get started.',
          }, null, 2),
        },
      ],
    };
  } catch (err) {
    if (err instanceof GIDError && err.code === 'FILE_EXISTS') {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              created: false,
              message: err.message,
              suggestion: 'Use force: true to overwrite',
            }, null, 2),
          },
        ],
      };
    }
    throw err;
  }
}

async function handleExtract(args: {
  paths?: string[];
  ignore?: string[];
  outputPath?: string;
  dryRun?: boolean;
  withSignatures?: boolean;
  withPatterns?: boolean;
  enrich?: boolean;
  group?: boolean;
  groupingDepth?: number;
}) {
  const dirs = args.paths && args.paths.length > 0 ? args.paths : [process.cwd()];
  const outputPath = args.outputPath ?? path.join(process.cwd(), '.gid', 'graph.yml');
  const withSignatures = args.withSignatures || args.enrich;
  const withPatterns = args.withPatterns || args.enrich;
  const shouldGroup = args.group || false;

  // Dry run - just preview
  if (args.dryRun) {
    const preview = await previewExtraction({
      baseDir: dirs[0],
      additionalDirs: dirs.slice(1),
      excludeDir: args.ignore,
    });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            dryRun: true,
            directories: preview.directories,
            filesFound: preview.files.length,
            files: preview.files.slice(0, 20),
            excludedDirs: preview.excludedDirsFound,
            outputPath,
            enrichment: { withSignatures, withPatterns },
            message: preview.files.length > 20
              ? `Showing first 20 of ${preview.files.length} files`
              : undefined,
          }, null, 2),
        },
      ],
    };
  }

  // Run extraction with enrichment options
  const result = await extractTypeScript({
    baseDir: dirs[0],
    additionalDirs: dirs.slice(1),
    excludeDir: args.ignore,
    withSignatures,
    withPatterns,
    enrich: args.enrich,
  });

  const enrichedCount = result.stats.enrichedNodes || 0;

  // Optionally group files into components
  let finalGraph = result.graph;
  let componentsCreated = result.stats.componentsFound;

  if (shouldGroup) {
    finalGraph = groupIntoComponents(result.graph, {
      groupingDepth: args.groupingDepth,
    });
    componentsCreated = Object.keys(finalGraph.nodes).length;
  }

  // Save graph
  const savedPath = saveGraph(finalGraph, outputPath);

  // Save to history
  const gidDir = path.dirname(outputPath);
  const stateManager = createStateManager(gidDir);
  stateManager.saveHistory(finalGraph);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          savedPath,
          stats: {
            filesScanned: result.stats.filesScanned,
            nodesCreated: componentsCreated,
            edgesFound: shouldGroup ? finalGraph.edges.length : result.stats.dependenciesFound,
            circularDeps: result.stats.circularDeps.length,
            enrichedNodes: enrichedCount,
            ...(shouldGroup ? { groupedFromFiles: result.stats.filesScanned } : {}),
          },
          enrichment: { withSignatures, withPatterns },
          grouping: shouldGroup ? { enabled: true, depth: args.groupingDepth ?? 'auto' } : undefined,
          warnings: result.warnings,
          circularDeps: result.stats.circularDeps.slice(0, 5),
          hint: shouldGroup
            ? 'Files grouped into components. Run `gid visual` to visualize.'
            : 'Run `gid visual --serve` to visualize the graph, or use gid_semantify to upgrade to semantic graph.',
        }, null, 2),
      },
    ],
  };
}

async function handleHistory(args: {
  graphPath?: string;
  action?: string;
  version?: string;
  force?: boolean;
}) {
  // Find the graph path and derive .gid directory from it
  const graphPath = args.graphPath ?? findGraphFile();
  if (!graphPath) {
    throw new McpError(ErrorCode.InvalidRequest, 'No graph.yml found');
  }
  const gidDir = path.dirname(graphPath);
  const stateManager = createStateManager(gidDir);
  const action = args.action ?? 'list';

  if (action === 'list') {
    const entries = stateManager.listHistory();

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            entries,
            count: entries.length,
            message: entries.length === 0
              ? 'No history entries found. Run gid_extract to create versions.'
              : undefined,
          }, null, 2),
        },
      ],
    };
  }

  if (action === 'diff') {
    if (!args.version) {
      throw new McpError(ErrorCode.InvalidRequest, 'Version required for diff action');
    }

    const currentGraph = loadGraph(graphPath);
    const historicalGraph = stateManager.loadHistoryVersion(args.version);

    if (!historicalGraph) {
      throw new McpError(ErrorCode.InvalidRequest, `Version not found: ${args.version}`);
    }

    const diff = diffGraphs(historicalGraph, currentGraph);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            comparing: `${args.version} → current`,
            ...diff,
          }, null, 2),
        },
      ],
    };
  }

  if (action === 'restore') {
    if (!args.version) {
      throw new McpError(ErrorCode.InvalidRequest, 'Version required for restore action');
    }

    const historicalGraph = stateManager.loadHistoryVersion(args.version);

    if (!historicalGraph) {
      throw new McpError(ErrorCode.InvalidRequest, `Version not found: ${args.version}`);
    }

    // Save current to history before restoring
    try {
      const currentGraph = loadGraph(graphPath);
      stateManager.saveHistory(currentGraph);
    } catch {
      // No current graph, that's fine
    }

    saveGraph(historicalGraph, graphPath);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            restored: true,
            version: args.version,
            nodeCount: Object.keys(historicalGraph.nodes || {}).length,
            edgeCount: (historicalGraph.edges || []).length,
          }, null, 2),
        },
      ],
    };
  }

  throw new McpError(ErrorCode.InvalidRequest, `Unknown action: ${action}`);
}

async function handleGetSchema(args: { includeExample?: boolean }) {
  const includeExample = args.includeExample !== false;

  const schema = {
    description: 'GID (Graph-Indexed Development) graph schema',
    nodeTypes: ['Feature', 'Component', 'Interface', 'Data', 'File', 'Test', 'Decision'],
    edgeRelations: ['implements', 'depends_on', 'calls', 'reads', 'writes', 'tested_by', 'defined_in', 'decided_by'],
    nodeProperties: {
      type: 'Required. One of the node types above.',
      description: 'Optional. Human-readable description.',
      status: 'Optional. One of: draft, in_progress, active, deprecated',
      priority: 'For Features only. One of: core, supporting, generic',
      layer: 'For Components only. One of: interface, application, domain, infrastructure',
      path: 'Optional. File path for File nodes.',
    },
    edgeProperties: {
      from: 'Required. Source node name.',
      to: 'Required. Target node name.',
      relation: 'Required. One of the edge relations above.',
      coupling: 'Optional. tight or loose',
      optional: 'Optional. boolean',
    },
    layerGuidelines: {
      interface: 'UI components, API endpoints, CLI handlers',
      application: 'Business logic orchestration, use cases, services',
      domain: 'Core business entities, rules, value objects',
      infrastructure: 'Database, external APIs, file system, caching',
    },
    example: includeExample ? {
      nodes: {
        UserRegistration: {
          type: 'Feature',
          description: 'User can create an account',
          priority: 'core',
        },
        UserService: {
          type: 'Component',
          description: 'Handles user CRUD operations',
          layer: 'application',
        },
        Database: {
          type: 'Component',
          description: 'PostgreSQL database connection',
          layer: 'infrastructure',
        },
      },
      edges: [
        { from: 'UserService', to: 'UserRegistration', relation: 'implements' },
        { from: 'UserService', to: 'Database', relation: 'depends_on' },
      ],
    } : undefined,
  };

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(schema, null, 2),
      },
    ],
  };
}

async function handleAnalyze(args: {
  filePath: string;
  function?: string;
  class?: string;
  includePatterns?: boolean;
}) {
  // If function name provided, get function details
  if (args.function) {
    const details = getFunctionDetails(args.filePath, args.function);
    if (!details) {
      throw new McpError(ErrorCode.InvalidRequest, `Function not found: ${args.function}`);
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ type: 'function', ...details }, null, 2),
        },
      ],
    };
  }

  // If class name provided, get class details
  if (args.class) {
    const details = getClassDetails(args.filePath, args.class);
    if (!details) {
      throw new McpError(ErrorCode.InvalidRequest, `Class not found: ${args.class}`);
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ type: 'class', ...details }, null, 2),
        },
      ],
    };
  }

  // Default: file overview
  const signatures = getFileSignatures(args.filePath);
  const patterns = args.includePatterns !== false ? detectFilePatterns(args.filePath) : [];

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ type: 'file', signatures, patterns }, null, 2),
      },
    ],
  };
}

async function handleAdvise(args: {
  graphPath?: string;
  level?: string;
  threshold?: number;
}) {
  const graphData = loadGraph(args.graphPath);
  const graph = new GIDGraph(graphData);
  const validator = new Validator({ highCouplingThreshold: args.threshold });
  const engine = new QueryEngine(graph);

  const validation = validator.validate(graph);
  const suggestions: Array<{
    level: string;
    type: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    suggestion?: string;
    nodeId?: string;
    fix?: object;
    codeContext?: object;
  }> = [];

  // Level 1: Deterministic suggestions from validation issues
  if (args.level === 'deterministic' || args.level === 'all' || !args.level) {
    for (const issue of validation.issues) {
      suggestions.push({
        level: 'deterministic',
        type: issue.rule,
        severity: issue.severity,
        message: issue.message,
        suggestion: issue.suggestion,
        nodeId: issue.nodes?.[0],
      });
    }

    // Check for missing implements edges
    const features = graph.getFeatures();
    const components = graph.getComponents();

    for (const [featureId] of features) {
      const implementers = graph.getImplementingComponents(featureId);
      if (implementers.length === 0) {
        suggestions.push({
          level: 'deterministic',
          type: 'missing-implements',
          severity: 'warning',
          message: `Feature "${featureId}" has no implementing components`,
          suggestion: 'Add an implements edge from a component to this feature',
          nodeId: featureId,
          fix: {
            action: 'add_edge',
            from: '{{component}}',
            to: featureId,
            relation: 'implements',
          },
        });
      }
    }

    // Check for orphan nodes
    for (const [nodeId] of Object.entries(graphData.nodes)) {
      const inEdges = graphData.edges.filter(e => e.to === nodeId);
      const outEdges = graphData.edges.filter(e => e.from === nodeId);

      if (inEdges.length === 0 && outEdges.length === 0) {
        suggestions.push({
          level: 'deterministic',
          type: 'orphan-node',
          severity: 'warning',
          message: `Node "${nodeId}" has no connections`,
          suggestion: 'Connect to related nodes or remove if unused',
          nodeId,
        });
      }
    }
  }

  // Level 2: Heuristic suggestions
  if (args.level === 'heuristic' || args.level === 'all' || !args.level) {
    // High coupling analysis
    const highCoupling = engine.getHighCouplingNodes(5);
    for (const { nodeId, dependentCount } of highCoupling) {
      suggestions.push({
        level: 'heuristic',
        type: 'high-coupling',
        severity: 'warning',
        message: `${nodeId} has ${dependentCount} dependents (high coupling)`,
        suggestion: 'Consider splitting into smaller components or introducing an abstraction layer',
        nodeId,
      });
    }

    // Deep dependency chains
    for (const [nodeId] of Object.entries(graphData.nodes)) {
      const deps = engine.getDependencies(nodeId, -1);
      if (deps.dependencies.length > 0) {
        const maxChain = calculateMaxChainDepth(graph, nodeId);
        if (maxChain > 4) {
          suggestions.push({
            level: 'heuristic',
            type: 'deep-chain',
            severity: 'info',
            message: `${nodeId} has a dependency chain of depth ${maxChain}`,
            suggestion: 'Consider flattening the dependency structure',
            nodeId,
          });
        }
      }
    }

    // Missing metadata
    for (const [featureId, node] of graph.getFeatures()) {
      if (!node.priority) {
        suggestions.push({
          level: 'heuristic',
          type: 'missing-priority',
          severity: 'info',
          message: `Feature "${featureId}" has no priority set`,
          suggestion: 'Add priority: core, supporting, or generic',
          nodeId: featureId,
        });
      }
    }

    for (const [compId, node] of graph.getComponents()) {
      if (!node.layer) {
        suggestions.push({
          level: 'heuristic',
          type: 'missing-layer',
          severity: 'info',
          message: `Component "${compId}" has no layer assigned`,
          suggestion: 'Add layer: interface, application, domain, or infrastructure',
          nodeId: compId,
        });
      }
    }
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          healthScore: validation.healthScore,
          // metrics: validation.metrics,  // TODO: Enable for modular architectures
          suggestionCount: suggestions.length,
          suggestions,
        }, null, 2),
      },
    ],
  };
}

async function handleRefactor(args: {
  graphPath?: string;
  operation: string;
  nodeId: string;
  newName?: string;
  newLayer?: string;
  dryRun?: boolean;
}) {
  const graphPath = args.graphPath ?? findGraphFile();
  if (!graphPath) {
    throw new McpError(ErrorCode.InvalidRequest, 'No graph.yml found');
  }

  const graphData = loadGraph(graphPath);
  const dryRun = args.dryRun !== false;

  const node = graphData.nodes[args.nodeId];
  if (!node) {
    throw new McpError(ErrorCode.InvalidRequest, `Node not found: ${args.nodeId}`);
  }

  const changes: Array<{
    type: string;
    description: string;
    before?: string;
    after?: string;
  }> = [];

  switch (args.operation) {
    case 'preview': {
      // Just return current state
      const inEdges = graphData.edges.filter(e => e.to === args.nodeId);
      const outEdges = graphData.edges.filter(e => e.from === args.nodeId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              nodeId: args.nodeId,
              node,
              incomingEdges: inEdges.length,
              outgoingEdges: outEdges.length,
              edges: { incoming: inEdges, outgoing: outEdges },
            }, null, 2),
          },
        ],
      };
    }

    case 'rename': {
      if (!args.newName) {
        throw new McpError(ErrorCode.InvalidRequest, 'newName required for rename operation');
      }

      changes.push({
        type: 'rename_node',
        description: `Rename node ${args.nodeId} to ${args.newName}`,
        before: args.nodeId,
        after: args.newName,
      });

      // Update edges
      for (const edge of graphData.edges) {
        if (edge.from === args.nodeId) {
          changes.push({
            type: 'update_edge',
            description: `Update edge from ${edge.from} to ${edge.to}`,
            before: edge.from,
            after: args.newName,
          });
        }
        if (edge.to === args.nodeId) {
          changes.push({
            type: 'update_edge',
            description: `Update edge to ${edge.to} from ${edge.from}`,
            before: edge.to,
            after: args.newName,
          });
        }
      }

      if (!dryRun) {
        // Apply changes
        graphData.nodes[args.newName] = node;
        delete graphData.nodes[args.nodeId];

        for (const edge of graphData.edges) {
          if (edge.from === args.nodeId) edge.from = args.newName;
          if (edge.to === args.nodeId) edge.to = args.newName;
        }

        saveGraph(graphData, graphPath);
      }
      break;
    }

    case 'move': {
      if (!args.newLayer) {
        throw new McpError(ErrorCode.InvalidRequest, 'newLayer required for move operation');
      }

      changes.push({
        type: 'change_layer',
        description: `Move ${args.nodeId} to ${args.newLayer} layer`,
        before: node.layer,
        after: args.newLayer,
      });

      if (!dryRun) {
        node.layer = args.newLayer as 'interface' | 'application' | 'domain' | 'infrastructure';
        saveGraph(graphData, graphPath);
      }
      break;
    }

    case 'delete': {
      changes.push({
        type: 'delete_node',
        description: `Delete node ${args.nodeId}`,
      });

      const affectedEdges = graphData.edges.filter(
        e => e.from === args.nodeId || e.to === args.nodeId
      );

      for (const edge of affectedEdges) {
        changes.push({
          type: 'delete_edge',
          description: `Delete edge ${edge.from} -> ${edge.to}`,
        });
      }

      if (!dryRun) {
        delete graphData.nodes[args.nodeId];
        graphData.edges = graphData.edges.filter(
          e => e.from !== args.nodeId && e.to !== args.nodeId
        );
        saveGraph(graphData, graphPath);
      }
      break;
    }

    default:
      throw new McpError(ErrorCode.InvalidRequest, `Unknown operation: ${args.operation}`);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          dryRun,
          operation: args.operation,
          nodeId: args.nodeId,
          changes,
          message: dryRun
            ? 'Preview only. Set dryRun: false to apply changes.'
            : 'Changes applied successfully.',
        }, null, 2),
      },
    ],
  };
}

async function handleSemantify(args: {
  graphPath?: string;
  scope?: string;
  dryRun?: boolean;
  returnContext?: boolean;
}) {
  const graphPath = args.graphPath ?? findGraphFile() ?? undefined;
  const graphData = loadGraph(graphPath);
  const scope = args.scope ?? 'all';
  const dryRun = args.dryRun !== false;

  // AI Semantic Mode: Return rich context for Claude to analyze
  if (args.returnContext) {
    const projectRoot = graphPath ? path.dirname(graphPath) : process.cwd();
    const context = gatherSemanticContext(
      { nodes: graphData.nodes as Record<string, any>, edges: graphData.edges },
      { projectRoot }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            mode: 'semantic_context',
            docs: context.docs.map(d => ({
              name: d.name,
              type: d.type,
              content: d.content,
            })),
            graphSummary: context.graphSummary,
            files: context.files,
            keyIdentifiers: {
              classes: context.identifiers.filter(i => i.kind === 'class').map(i => i.name),
              functions: context.identifiers.filter(i => i.kind === 'function' && i.signature).slice(0, 30).map(i => ({
                name: i.name,
                signature: i.signature,
              })),
            },
            aiPrompt: `Based on the documentation and code structure above, provide semantic analysis in JSON format:

{
  "features": [
    { "name": "User-Friendly Name", "description": "One sentence", "components": ["nodeId1", "nodeId2"] }
  ],
  "layerAssignments": [
    { "nodeId": "...", "layer": "interface|application|domain|infrastructure", "reason": "..." }
  ],
  "descriptions": [
    { "nodeId": "...", "description": "One sentence description" }
  ]
}

IMPORTANT about Features:
- Features are USER-PERCEIVABLE capabilities, NOT code classes
- Use human-readable names like "Graph Querying" or "Code Extraction" (NOT "GraphQuerying")
- Features describe WHAT the system does for users, not HOW it's implemented
- Example: "Impact Analysis" (feature) vs "QueryEngine" (code class)

Then use gid_edit_graph to apply the changes.`,
          }, null, 2),
        },
      ],
    };
  }

  // Heuristic mode (default)

  const proposals: Array<{
    type: string;
    nodeId: string;
    current?: object;
    proposed: object;
    reason: string;
    confidence: number;
  }> = [];

  // Analyze nodes to propose semantic upgrades
  for (const [nodeId, node] of Object.entries(graphData.nodes)) {
    // Skip nodes without paths (e.g., Features, abstract nodes)
    if (!node.path) continue;

    try {
      const patterns = detectFilePatterns(node.path);
      const signatures = getFileSignatures(node.path);

      // Propose layer assignment (for any node with a path)
      if ((scope === 'layers' || scope === 'all') && !node.layer) {
        const layerProposal = proposeLayer(patterns, node.path);
        if (layerProposal) {
          proposals.push({
            type: 'assign_layer',
            nodeId,
            proposed: { layer: layerProposal.layer },
            reason: layerProposal.reason,
            confidence: layerProposal.confidence,
          });
        }
      }

      // Propose component grouping (only for File nodes)
      if ((scope === 'components' || scope === 'all') && node.type === 'File') {
        const componentProposal = proposeComponent(patterns, signatures, nodeId);
        if (componentProposal) {
          proposals.push({
            type: 'upgrade_to_component',
            nodeId,
            current: { type: 'File' },
            proposed: { type: 'Component', ...componentProposal.metadata },
            reason: componentProposal.reason,
            confidence: componentProposal.confidence,
          });
        }
      }

      // Propose feature detection
      if (scope === 'features' || scope === 'all') {
        const featureProposal = proposeFeature(patterns, signatures, nodeId);
        if (featureProposal) {
          proposals.push({
            type: 'link_to_feature',
            nodeId,
            proposed: { feature: featureProposal.feature, relation: 'implements' },
            reason: featureProposal.reason,
            confidence: featureProposal.confidence,
          });
        }
      }
    } catch {
      // Skip files that can't be analyzed
    }
  }

  // Sort by confidence
  proposals.sort((a, b) => b.confidence - a.confidence);

  // Apply changes if not dry run
  let appliedCount = 0;
  if (!dryRun) {
    const graphPath = args.graphPath ?? findGraphFile();
    if (!graphPath) {
      throw new McpError(ErrorCode.InvalidRequest, 'No graph.yml found to apply changes');
    }

    for (const proposal of proposals) {
      const node = graphData.nodes[proposal.nodeId];
      if (!node) continue;

      switch (proposal.type) {
        case 'assign_layer': {
          const proposed = proposal.proposed as { layer: string };
          node.layer = proposed.layer as 'interface' | 'application' | 'domain' | 'infrastructure';
          appliedCount++;
          break;
        }
        case 'upgrade_to_component': {
          const proposed = proposal.proposed as { type: string; description?: string; pattern?: string };
          node.type = 'Component';
          if (proposed.description) node.description = proposed.description;
          appliedCount++;
          break;
        }
        case 'link_to_feature': {
          const proposed = proposal.proposed as { feature: string; relation: string };
          // Create feature if it doesn't exist
          if (!graphData.nodes[proposed.feature]) {
            graphData.nodes[proposed.feature] = {
              type: 'Feature',
              description: `Feature: ${proposed.feature}`,
            };
          }
          // Add implements edge if not exists
          const edgeExists = graphData.edges.some(
            e => e.from === proposal.nodeId && e.to === proposed.feature && e.relation === 'implements'
          );
          if (!edgeExists) {
            graphData.edges.push({
              from: proposal.nodeId,
              to: proposed.feature,
              relation: 'implements',
            });
          }
          appliedCount++;
          break;
        }
      }
    }

    // Save the updated graph
    saveGraph(graphData, graphPath);

    // Save to history
    const gidDir = path.dirname(graphPath);
    const stateManager = createStateManager(gidDir);
    stateManager.saveHistory(graphData);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          dryRun,
          scope,
          proposalCount: proposals.length,
          appliedCount: dryRun ? 0 : appliedCount,
          proposals,
          message: dryRun
            ? 'Preview only. Set dryRun: false to apply changes.'
            : `Applied ${appliedCount} changes to the graph.`,
          hint: dryRun
            ? undefined
            : 'Run `gid visual --serve` to visualize the updated graph.',
          aiPrompt: dryRun
            ? `Review these semantic upgrade proposals for the dependency graph. Each proposal includes a confidence score. High-confidence proposals (>0.8) can likely be auto-applied. Medium-confidence proposals (0.5-0.8) should be reviewed. Suggest which proposals to accept, modify, or reject.`
            : undefined,
        }, null, 2),
      },
    ],
  };
}

async function handleGetFileSummary(args: { filePath: string; includeContent?: boolean }) {
  const summaryInput = prepareFileSummary(args.filePath, args.includeContent);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ...summaryInput,
          aiPrompt: 'Based on the file signatures, patterns, and content, generate a concise one-sentence description of what this file does and its role in the codebase.',
        }, null, 2),
      },
    ],
  };
}

interface EditOperation {
  action: 'add_node' | 'update_node' | 'delete_node' | 'add_edge' | 'delete_edge';
  nodeId?: string;
  node?: {
    type?: string;
    description?: string;
    layer?: string;
    status?: string;
    priority?: string;
    path?: string;
  };
  edge?: {
    from?: string;
    to?: string;
    relation?: string;
  };
}

async function handleEditGraph(args: {
  graphPath?: string;
  operations: EditOperation[];
  dryRun?: boolean;
}) {
  const graphPath = args.graphPath ?? findGraphFile();
  if (!graphPath) {
    throw new McpError(ErrorCode.InvalidRequest, 'No graph.yml found');
  }

  const graphData = loadGraph(graphPath);
  const dryRun = args.dryRun === true;

  const results: Array<{
    action: string;
    success: boolean;
    message: string;
    details?: object;
  }> = [];

  for (const op of args.operations) {
    try {
      switch (op.action) {
        case 'add_node': {
          if (!op.nodeId) {
            results.push({ action: op.action, success: false, message: 'nodeId required' });
            break;
          }
          if (graphData.nodes[op.nodeId]) {
            results.push({ action: op.action, success: false, message: `Node "${op.nodeId}" already exists` });
            break;
          }
          if (!op.node?.type) {
            results.push({ action: op.action, success: false, message: 'node.type required' });
            break;
          }

          const newNode: Record<string, unknown> = {
            type: op.node.type,
          };
          if (op.node.description) newNode.description = op.node.description;
          if (op.node.layer) newNode.layer = op.node.layer;
          if (op.node.status) newNode.status = op.node.status;
          if (op.node.priority) newNode.priority = op.node.priority;
          if (op.node.path) newNode.path = op.node.path;

          if (!dryRun) {
            graphData.nodes[op.nodeId] = newNode as typeof graphData.nodes[string];
          }
          results.push({
            action: op.action,
            success: true,
            message: `Added node "${op.nodeId}"`,
            details: newNode,
          });
          break;
        }

        case 'update_node': {
          if (!op.nodeId) {
            results.push({ action: op.action, success: false, message: 'nodeId required' });
            break;
          }
          if (!graphData.nodes[op.nodeId]) {
            results.push({ action: op.action, success: false, message: `Node "${op.nodeId}" not found` });
            break;
          }

          const updates: Record<string, unknown> = {};
          if (op.node?.type) updates.type = op.node.type;
          if (op.node?.description) updates.description = op.node.description;
          if (op.node?.layer) updates.layer = op.node.layer;
          if (op.node?.status) updates.status = op.node.status;
          if (op.node?.priority) updates.priority = op.node.priority;
          if (op.node?.path) updates.path = op.node.path;

          if (!dryRun) {
            Object.assign(graphData.nodes[op.nodeId], updates);
          }
          results.push({
            action: op.action,
            success: true,
            message: `Updated node "${op.nodeId}"`,
            details: updates,
          });
          break;
        }

        case 'delete_node': {
          if (!op.nodeId) {
            results.push({ action: op.action, success: false, message: 'nodeId required' });
            break;
          }
          if (!graphData.nodes[op.nodeId]) {
            results.push({ action: op.action, success: false, message: `Node "${op.nodeId}" not found` });
            break;
          }

          // Count affected edges
          const affectedEdges = graphData.edges.filter(
            e => e.from === op.nodeId || e.to === op.nodeId
          );

          if (!dryRun) {
            delete graphData.nodes[op.nodeId];
            graphData.edges = graphData.edges.filter(
              e => e.from !== op.nodeId && e.to !== op.nodeId
            );
          }
          results.push({
            action: op.action,
            success: true,
            message: `Deleted node "${op.nodeId}" and ${affectedEdges.length} edges`,
            details: { affectedEdges: affectedEdges.length },
          });
          break;
        }

        case 'add_edge': {
          if (!op.edge?.from || !op.edge?.to || !op.edge?.relation) {
            results.push({ action: op.action, success: false, message: 'edge.from, edge.to, and edge.relation required' });
            break;
          }
          if (!graphData.nodes[op.edge.from]) {
            results.push({ action: op.action, success: false, message: `Source node "${op.edge.from}" not found` });
            break;
          }
          if (!graphData.nodes[op.edge.to]) {
            results.push({ action: op.action, success: false, message: `Target node "${op.edge.to}" not found` });
            break;
          }

          // Check for duplicate
          const exists = graphData.edges.some(
            e => e.from === op.edge!.from && e.to === op.edge!.to && e.relation === op.edge!.relation
          );
          if (exists) {
            results.push({ action: op.action, success: false, message: 'Edge already exists' });
            break;
          }

          const newEdge = {
            from: op.edge.from,
            to: op.edge.to,
            relation: op.edge.relation as typeof graphData.edges[0]['relation'],
          };

          if (!dryRun) {
            graphData.edges.push(newEdge);
          }
          results.push({
            action: op.action,
            success: true,
            message: `Added edge ${op.edge.from} -[${op.edge.relation}]-> ${op.edge.to}`,
            details: newEdge,
          });
          break;
        }

        case 'delete_edge': {
          if (!op.edge?.from || !op.edge?.to) {
            results.push({ action: op.action, success: false, message: 'edge.from and edge.to required' });
            break;
          }

          const edgeIndex = graphData.edges.findIndex(
            e => e.from === op.edge!.from && e.to === op.edge!.to &&
              (!op.edge!.relation || e.relation === op.edge!.relation)
          );

          if (edgeIndex === -1) {
            results.push({ action: op.action, success: false, message: 'Edge not found' });
            break;
          }

          const deletedEdge = graphData.edges[edgeIndex];
          if (!dryRun) {
            graphData.edges.splice(edgeIndex, 1);
          }
          results.push({
            action: op.action,
            success: true,
            message: `Deleted edge ${deletedEdge.from} -[${deletedEdge.relation}]-> ${deletedEdge.to}`,
          });
          break;
        }

        default:
          results.push({ action: op.action, success: false, message: `Unknown action: ${op.action}` });
      }
    } catch (err) {
      results.push({ action: op.action, success: false, message: String(err) });
    }
  }

  // Save if not dry run and at least one success
  const successCount = results.filter(r => r.success).length;
  if (!dryRun && successCount > 0) {
    saveGraph(graphData, graphPath);

    // Save to history
    const gidDir = path.dirname(graphPath);
    const stateManager = createStateManager(gidDir);
    stateManager.saveHistory(graphData);
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          dryRun,
          operationsRequested: args.operations.length,
          successCount,
          failureCount: results.length - successCount,
          results,
          message: dryRun
            ? 'Preview only. Set dryRun: false to apply changes.'
            : `Applied ${successCount} operations to the graph.`,
        }, null, 2),
      },
    ],
  };
}

async function handleVisual(args: {
  graphPath?: string;
  outputPath?: string;
}) {
  const graphPath = args.graphPath ?? findGraphFile();
  if (!graphPath) {
    throw new McpError(ErrorCode.InvalidRequest, 'No graph.yml found');
  }

  const graphData = loadGraph(graphPath);
  const html = generateStaticHTML(graphData);

  // If output path specified, save to file
  if (args.outputPath) {
    const fs = await import('fs');
    const resolvedPath = path.resolve(args.outputPath);
    fs.writeFileSync(resolvedPath, html, 'utf-8');

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            outputPath: resolvedPath,
            nodeCount: Object.keys(graphData.nodes || {}).length,
            edgeCount: (graphData.edges || []).length,
            message: `Static visualization saved to ${resolvedPath}`,
            hint: `Open the file in a browser: file://${resolvedPath}`,
          }, null, 2),
        },
      ],
    };
  }

  // Return HTML content directly
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: true,
          nodeCount: Object.keys(graphData.nodes || {}).length,
          edgeCount: (graphData.edges || []).length,
          html,
          message: 'Static HTML visualization generated. Save this HTML content to a file and open in a browser.',
          hint: 'For interactive visualization with live reloading, run: gid visual --serve',
        }, null, 2),
      },
    ],
  };
}

/**
 * Generate static HTML visualization with embedded graph data
 */
function generateStaticHTML(graphData: { nodes: Record<string, unknown>; edges: Array<{ from: string; to: string; relation: string }> }): string {
  const nodeCount = Object.keys(graphData.nodes || {}).length;
  const edgeCount = (graphData.edges || []).length;
  const graphDataJson = JSON.stringify(graphData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GID Visual - Graph Visualization</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      overflow: hidden;
    }
    #header {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: 50px;
      background: #16213e;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      z-index: 100;
      border-bottom: 1px solid #0f3460;
    }
    #header h1 { font-size: 18px; font-weight: 500; color: #e94560; }
    #controls { display: flex; gap: 10px; align-items: center; }
    #controls input {
      padding: 6px 12px;
      border-radius: 4px;
      border: 1px solid #0f3460;
      background: #1a1a2e;
      color: #eee;
      width: 200px;
    }
    #controls button {
      padding: 6px 12px;
      border-radius: 4px;
      border: none;
      background: #e94560;
      color: white;
      cursor: pointer;
    }
    #controls button:hover { background: #ff6b6b; }
    #graph { position: fixed; top: 50px; left: 0; right: 0; bottom: 50px; }
    #footer {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      height: 50px;
      background: #16213e;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
      border-top: 1px solid #0f3460;
      font-size: 14px;
      color: #888;
    }
    #footer .stat { margin-right: 20px; }
    #footer .health-score { font-weight: bold; }
    #details {
      position: fixed;
      right: 20px; top: 70px;
      width: 300px;
      background: #16213e;
      border-radius: 8px;
      padding: 20px;
      display: none;
      border: 1px solid #0f3460;
    }
    #details.visible { display: block; }
    #details h3 { color: #e94560; margin-bottom: 10px; }
    #details .property { margin: 8px 0; }
    #details .property label { color: #888; font-size: 12px; display: block; }
    .node { cursor: pointer; }
    .node circle { stroke: #fff; stroke-width: 2px; }
    .node text { fill: #eee; font-size: 12px; pointer-events: none; }
    .link { stroke: #0f3460; stroke-opacity: 0.6; }
    .link.implements { stroke: #4caf50; }
    .link.depends_on { stroke: #2196f3; }
    .link.calls { stroke: #ff9800; }
    .link.reads { stroke: #9c27b0; }
    .link.writes { stroke: #f44336; }
    .legend {
      position: fixed;
      left: 20px; bottom: 70px;
      background: #16213e;
      padding: 15px;
      border-radius: 8px;
      font-size: 12px;
      border: 1px solid #0f3460;
    }
    .legend-item { display: flex; align-items: center; margin: 4px 0; font-size: 11px; }
    .legend-color { width: 20px; height: 3px; margin-right: 8px; }
    .legend-node { width: 14px; height: 14px; border-radius: 50%; margin-right: 8px; }
    .legend-section { margin-bottom: 10px; }
    .legend-title { font-size: 10px; color: #888; text-transform: uppercase; margin-bottom: 4px; letter-spacing: 0.5px; }
    .static-badge {
      background: #0f3460;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      margin-left: 10px;
    }
  </style>
</head>
<body>
  <div id="header">
    <h1>GID Visual <span class="static-badge">Static</span></h1>
    <div id="controls">
      <input type="text" id="search" placeholder="Search nodes...">
      <button onclick="resetZoom()">Reset View</button>
    </div>
  </div>

  <div id="graph"></div>

  <div id="details">
    <h3 id="node-name">Node</h3>
    <div id="node-properties"></div>
  </div>

  <div class="legend">
    <div class="legend-section">
      <div class="legend-title">Edge Types</div>
      <div class="legend-item"><div class="legend-color" style="background:#4caf50"></div>implements</div>
      <div class="legend-item"><div class="legend-color" style="background:#2196f3"></div>depends_on</div>
      <div class="legend-item"><div class="legend-color" style="background:#ff9800"></div>calls</div>
      <div class="legend-item"><div class="legend-color" style="background:#9c27b0"></div>reads</div>
      <div class="legend-item"><div class="legend-color" style="background:#f44336"></div>writes</div>
      <div class="legend-item"><svg width="20" height="3" style="margin-right:8px"><line x1="0" y1="1.5" x2="20" y2="1.5" stroke="#2196f3" stroke-width="2" stroke-dasharray="4,2"/></svg>internal (within component)</div>
    </div>
    <div class="legend-section">
      <div class="legend-title">Node Types</div>
      <div class="legend-item"><div class="legend-node" style="background:#e94560"></div>Feature</div>
      <div class="legend-item"><div class="legend-node" style="background:#4caf50"></div>Component</div>
      <div class="legend-item"><div class="legend-node" style="background:#607d8b"></div>File</div>
    </div>
    <div class="legend-section">
      <div class="legend-title">Layers (border color)</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #2196f3"></div>interface</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #4caf50"></div>application</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #ff9800"></div>domain</div>
      <div class="legend-item"><div class="legend-node" style="background:transparent;border:3px solid #9c27b0"></div>infrastructure</div>
    </div>
  </div>

  <div id="footer">
    <div>
      <span class="stat">Nodes: <span id="node-count">${nodeCount}</span></span>
      <span class="stat">Edges: <span id="edge-count">${edgeCount}</span></span>
      <span class="stat health-score">Health: <span id="health-score">--</span>/100</span>
    </div>
    <div>GID MCP - Static Export</div>
  </div>

  <script>
    // Embedded graph data (no server needed)
    const graphData = ${graphDataJson};

    // Calculate health score
    function calculateHealthScore() {
      const nodes = Object.entries(graphData.nodes || {});
      const edges = graphData.edges || [];
      if (nodes.length === 0) return 0;

      let score = 100;
      let issues = 0;

      // Check for orphan nodes (no connections)
      const connectedNodes = new Set();
      edges.forEach(e => {
        connectedNodes.add(e.from);
        connectedNodes.add(e.to);
      });
      const orphans = nodes.filter(([id]) => !connectedNodes.has(id));
      issues += orphans.length * 5; // -5 per orphan

      // Check for nodes without layers (except Features)
      const noLayer = nodes.filter(([_, n]) => !n.layer && n.type !== 'Feature' && !n.children);
      issues += noLayer.length * 2; // -2 per node without layer

      // Check for nodes without descriptions (except Files)
      const noDesc = nodes.filter(([_, n]) => !n.description && n.type !== 'File' && !n.children);
      issues += noDesc.length * 1; // -1 per node without description

      score = Math.max(0, Math.min(100, 100 - issues));
      return score;
    }

    const healthScore = calculateHealthScore();
    document.addEventListener('DOMContentLoaded', () => {
      const healthEl = document.getElementById('health-score');
      if (healthEl) {
        healthEl.textContent = healthScore;
        healthEl.style.color = healthScore >= 80 ? '#4caf50' : healthScore >= 50 ? '#ff9800' : '#f44336';
      }
    });

    let simulation = null;
    let svg = null;
    let g = null;
    let zoom = null;

    // Track expanded components
    const expandedNodes = new Set();

    // Type-based colors
    const typeColors = {
      Feature: '#e94560',
      Component: '#4caf50',
      Interface: '#ff9800',
      Data: '#9c27b0',
      File: '#607d8b',
      Test: '#00bcd4',
      Decision: '#795548',
    };

    // Layer-based colors (used for File nodes or as border)
    const layerColors = {
      interface: '#2196f3',    // Blue - API/UI layer
      application: '#4caf50',  // Green - Business logic
      domain: '#ff9800',       // Orange - Core domain
      infrastructure: '#9c27b0', // Purple - Database/external
    };

    // Status-based opacity
    const statusOpacity = {
      active: 1.0,
      in_progress: 0.85,
      draft: 0.5,        // Greyer for proposed/draft nodes
      deprecated: 0.4,   // Faded for deprecated
    };

    function getNodeColor(node) {
      // If node has a layer, use layer color (works for File, Component, etc.)
      if (node.layer && layerColors[node.layer]) {
        return layerColors[node.layer];
      }
      return typeColors[node.type] || '#607d8b';
    }

    function getNodeOpacity(node) {
      return statusOpacity[node.status] || 1.0;
    }

    function getVisibleNodes() {
      const nodes = [];
      const nodeMap = {};

      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        if (expandedNodes.has(id) && data.children && data.children.length > 0) {
          // Add parent as collapsed indicator
          const parentNode = { id, ...data, isExpanded: true };
          nodes.push(parentNode);
          nodeMap[id] = parentNode;

          // Add children
          for (const child of data.children) {
            const childNode = { ...child, parentId: id, isChild: true };
            nodes.push(childNode);
            nodeMap[child.id] = childNode;
          }
        } else {
          const node = { id, ...data, hasChildren: data.children && data.children.length > 0 };
          nodes.push(node);
          nodeMap[id] = node;
        }
      }
      return { nodes, nodeMap };
    }

    function getVisibleLinks(nodeMap) {
      const links = [];
      const addedLinks = new Set();

      // Build file-to-component map for resolving external edges
      const fileToComponent = {};
      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        if (data.children) {
          for (const child of data.children) {
            fileToComponent[child.id] = id;
          }
        }
      }

      // Helper to resolve a file ID to its visible node
      function resolveToVisible(fileId) {
        // If the file is directly in nodeMap, use it
        if (nodeMap[fileId]) return fileId;
        // Otherwise map to its component
        const compId = fileToComponent[fileId];
        if (compId && nodeMap[compId]) return compId;
        return null;
      }

      for (const edge of (graphData.edges || [])) {
        const sourceInMap = nodeMap[edge.from];
        const targetInMap = nodeMap[edge.to];

        if (sourceInMap && targetInMap) {
          const linkKey = edge.from + '->' + edge.to;
          if (!addedLinks.has(linkKey)) {
            links.push({ source: edge.from, target: edge.to, relation: edge.relation });
            addedLinks.add(linkKey);
          }
        }
      }

      // Add edges between expanded children (from stored childEdges)
      for (const [id, data] of Object.entries(graphData.nodes || {})) {
        if (expandedNodes.has(id) && data.childEdges) {
          for (const edge of data.childEdges) {
            const linkKey = edge.from + '->' + edge.to;
            if (!addedLinks.has(linkKey)) {
              links.push({ source: edge.from, target: edge.to, relation: edge.relation, isInternal: true });
              addedLinks.add(linkKey);
            }
          }
        }

        // Add external edges from expanded children to other components
        if (expandedNodes.has(id) && data.childExternalEdges) {
          for (const edge of data.childExternalEdges) {
            const sourceVisible = resolveToVisible(edge.from);
            const targetVisible = resolveToVisible(edge.to);

            if (sourceVisible && targetVisible && sourceVisible !== targetVisible) {
              const linkKey = sourceVisible + '->' + targetVisible;
              if (!addedLinks.has(linkKey)) {
                links.push({ source: sourceVisible, target: targetVisible, relation: edge.relation, isExternal: true });
                addedLinks.add(linkKey);
              }
            }
          }
        }
      }

      return links;
    }

    function toggleExpand(nodeId) {
      if (expandedNodes.has(nodeId)) {
        expandedNodes.delete(nodeId);
      } else {
        expandedNodes.add(nodeId);
      }
      renderGraph();
    }

    function renderGraph() {
      const container = document.getElementById('graph');
      const width = container.clientWidth;
      const height = container.clientHeight;

      container.innerHTML = '';

      svg = d3.select('#graph')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

      zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => g.attr('transform', event.transform));

      svg.call(zoom);
      g = svg.append('g');

      const { nodes, nodeMap } = getVisibleNodes();
      const links = getVisibleLinks(nodeMap);

      simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(links).id(d => d.id).distance(d => d.isInternal ? 60 : 100))
        .force('charge', d3.forceManyBody().strength(d => d.isChild ? -150 : -300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(d => d.isChild ? 30 : 50));

      const link = g.append('g')
        .selectAll('line')
        .data(links)
        .join('line')
        .attr('class', d => 'link ' + d.relation + (d.isInternal ? ' internal' : ''))
        .attr('stroke-width', d => d.isInternal ? 1 : 2)
        .attr('stroke-dasharray', d => d.isInternal ? '3,3' : null);

      const node = g.append('g')
        .selectAll('g')
        .data(nodes)
        .join('g')
        .attr('class', d => 'node' + (d.isChild ? ' child-node' : '') + (d.hasChildren ? ' expandable' : ''))
        .on('click', (event, d) => showDetails(d))
        .on('dblclick', (event, d) => {
          if (d.hasChildren || d.isExpanded) {
            event.stopPropagation();
            toggleExpand(d.id);
          }
        });

      node.append('circle')
        .attr('r', d => d.isChild ? 15 : 20)
        .attr('fill', d => getNodeColor(d))
        .attr('opacity', d => getNodeOpacity(d))
        .attr('stroke', d => d.layer ? layerColors[d.layer] : (d.hasChildren ? '#fff' : null))
        .attr('stroke-width', d => d.hasChildren ? 3 : (d.layer ? 3 : 2))
        .attr('stroke-dasharray', d => d.hasChildren && !d.isExpanded ? '4,2' : null);

      // Add expand indicator for expandable nodes
      node.filter(d => d.hasChildren && !d.isExpanded)
        .append('text')
        .text('+')
        .attr('text-anchor', 'middle')
        .attr('dy', 5)
        .attr('fill', '#fff')
        .attr('font-size', '16px')
        .attr('font-weight', 'bold')
        .style('pointer-events', 'none');

      // Add collapse indicator for expanded nodes
      node.filter(d => d.isExpanded)
        .append('text')
        .text('−')
        .attr('text-anchor', 'middle')
        .attr('dy', 5)
        .attr('fill', '#fff')
        .attr('font-size', '20px')
        .attr('font-weight', 'bold')
        .style('pointer-events', 'none');

      node.append('text')
        .attr('class', 'node-label')
        .text(d => {
          const label = d.id.split('/').pop() || d.id;
          return label.length > 15 ? label.substring(0, 12) + '...' : label;
        })
        .attr('text-anchor', 'middle')
        .attr('dy', d => d.isChild ? 28 : 35)
        .attr('opacity', d => getNodeOpacity(d))
        .attr('font-size', d => d.isChild ? '10px' : '12px');

      simulation.on('tick', () => {
        link
          .attr('x1', d => d.source.x)
          .attr('y1', d => d.source.y)
          .attr('x2', d => d.target.x)
          .attr('y2', d => d.target.y);
        node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
      });

      // Update node count
      document.getElementById('node-count').textContent = nodes.length;
      document.getElementById('edge-count').textContent = links.length;
    }

    function showDetails(node) {
      const details = document.getElementById('details');
      document.getElementById('node-name').textContent = node.id;
      const props = document.getElementById('node-properties');
      props.innerHTML = '';
      ['type', 'description', 'layer', 'path', 'status', 'priority'].forEach(key => {
        if (node[key]) {
          props.innerHTML += \`<div class="property"><label>\${key}</label><div>\${node[key]}</div></div>\`;
        }
      });
      details.classList.add('visible');
    }

    function resetZoom() {
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    }

    document.getElementById('search').addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      d3.selectAll('.node').each(function(d) {
        const match = d.id.toLowerCase().includes(query);
        d3.select(this).style('opacity', query === '' ? 1 : (match ? 1 : 0.2));
      });
    });

    // Render on load
    renderGraph();
  </script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions for Semantify
// ═══════════════════════════════════════════════════════════════════════════════

function calculateMaxChainDepth(graph: GIDGraph, nodeId: string, visited: Set<string> = new Set()): number {
  if (visited.has(nodeId)) return 0;
  visited.add(nodeId);

  const outgoing = graph.getOutgoingEdges(nodeId);
  if (outgoing.length === 0) return 0;

  let maxDepth = 0;
  for (const edge of outgoing) {
    const depth = calculateMaxChainDepth(graph, edge.to, visited);
    maxDepth = Math.max(maxDepth, depth + 1);
  }

  return maxDepth;
}

function proposeLayer(
  patterns: Array<{ pattern: string; confidence: number }>,
  filePath: string
): { layer: string; reason: string; confidence: number } | null {
  const pathLower = filePath.toLowerCase();

  // ─────────────────────────────────────────────────────────────────────────────
  // Interface layer: User-facing entry points (CLI commands, API routes, UI)
  // ─────────────────────────────────────────────────────────────────────────────
  if (pathLower.includes('/commands/') || pathLower.includes('/cmd/')) {
    return { layer: 'interface', reason: 'CLI commands are interface layer', confidence: 0.9 };
  }
  if (pathLower.includes('/api/') || pathLower.includes('/routes/') || pathLower.includes('/controllers/')) {
    return { layer: 'interface', reason: 'Path indicates API/route layer', confidence: 0.85 };
  }
  if (pathLower.includes('/components/') || pathLower.includes('/ui/') || pathLower.includes('/views/')) {
    return { layer: 'interface', reason: 'Path indicates UI layer', confidence: 0.85 };
  }
  if (pathLower.includes('/web/') || pathLower.includes('/pages/')) {
    return { layer: 'interface', reason: 'Path indicates web interface layer', confidence: 0.85 };
  }
  if (pathLower.includes('/handlers/') || pathLower.includes('/endpoints/')) {
    return { layer: 'interface', reason: 'Path indicates handler/endpoint layer', confidence: 0.85 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Application layer: Use cases, services, orchestration
  // ─────────────────────────────────────────────────────────────────────────────
  if (pathLower.includes('/services/') || pathLower.includes('/usecases/')) {
    return { layer: 'application', reason: 'Path indicates service/usecase layer', confidence: 0.85 };
  }
  if (pathLower.includes('/analyzers/') || pathLower.includes('/processors/')) {
    return { layer: 'application', reason: 'Path indicates analyzer/processor layer', confidence: 0.8 };
  }
  if (pathLower.includes('/ai/') || pathLower.includes('/llm/')) {
    return { layer: 'application', reason: 'Path indicates AI integration layer', confidence: 0.8 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Domain layer: Core business logic, types, entities
  // ─────────────────────────────────────────────────────────────────────────────
  if (pathLower.includes('/core/') || pathLower.includes('/lib/')) {
    return { layer: 'domain', reason: 'Path indicates core/lib domain layer', confidence: 0.85 };
  }
  if (pathLower.includes('/domain/') || pathLower.includes('/entities/') || pathLower.includes('/models/')) {
    return { layer: 'domain', reason: 'Path indicates domain layer', confidence: 0.85 };
  }
  if (pathLower.includes('/types/') || pathLower.match(/\/[^/]*types?\.(ts|js)$/)) {
    return { layer: 'domain', reason: 'Type definitions are domain layer', confidence: 0.8 };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Infrastructure layer: External interfaces (DB, filesystem, network)
  // ─────────────────────────────────────────────────────────────────────────────
  if (pathLower.includes('/extractors/') || pathLower.includes('/parsers/')) {
    return { layer: 'infrastructure', reason: 'Path indicates extractor/parser infrastructure', confidence: 0.85 };
  }
  if (pathLower.includes('/infrastructure/') || pathLower.includes('/db/') || pathLower.includes('/repositories/')) {
    return { layer: 'infrastructure', reason: 'Path indicates infrastructure layer', confidence: 0.85 };
  }
  if (pathLower.includes('/adapters/') || pathLower.includes('/clients/')) {
    return { layer: 'infrastructure', reason: 'Path indicates adapter/client infrastructure', confidence: 0.85 };
  }
  if (pathLower.includes('/config/') || pathLower.includes('/settings/')) {
    return { layer: 'infrastructure', reason: 'Path indicates config infrastructure', confidence: 0.8 };
  }

  // Pattern-based inference
  for (const { pattern, confidence } of patterns) {
    switch (pattern) {
      case 'controller':
      case 'middleware':
      case 'react-component':
        return { layer: 'interface', reason: `Detected ${pattern} pattern`, confidence: confidence * 0.9 };
      case 'service':
        return { layer: 'application', reason: 'Detected service pattern', confidence: confidence * 0.9 };
      case 'entity':
        return { layer: 'domain', reason: 'Detected entity pattern', confidence: confidence * 0.9 };
      case 'repository':
        return { layer: 'infrastructure', reason: 'Detected repository pattern', confidence: confidence * 0.9 };
    }
  }

  return null;
}

function proposeComponent(
  patterns: Array<{ pattern: string; confidence: number }>,
  signatures: { functions: unknown[]; classes: unknown[]; exports: string[] },
  nodeId: string
): { metadata: object; reason: string; confidence: number } | null {
  // Files with classes or multiple exported functions are good component candidates
  if (signatures.classes.length > 0) {
    const primaryPattern = patterns[0]?.pattern;
    return {
      metadata: {
        description: `Component based on ${signatures.classes.length} class(es)`,
        pattern: primaryPattern,
      },
      reason: 'File contains class definitions',
      confidence: 0.8,
    };
  }

  if (signatures.exports.length >= 3) {
    return {
      metadata: {
        description: `Component with ${signatures.exports.length} exports`,
      },
      reason: 'File has multiple exports indicating a cohesive module',
      confidence: 0.7,
    };
  }

  return null;
}

function proposeFeature(
  patterns: Array<{ pattern: string; confidence: number }>,
  signatures: { functions: unknown[]; classes: unknown[]; exports: string[] },
  nodeId: string
): { feature: string; reason: string; confidence: number } | null {
  // Look for patterns that suggest feature implementation
  for (const { pattern, confidence } of patterns) {
    if (['controller', 'service'].includes(pattern)) {
      // Try to infer feature name from node ID
      const featureName = inferFeatureName(nodeId);
      if (featureName) {
        return {
          feature: featureName,
          reason: `${pattern} pattern suggests feature implementation`,
          confidence: confidence * 0.7,
        };
      }
    }
  }

  return null;
}

function inferFeatureName(nodeId: string): string | null {
  // Extract potential feature name from node ID
  const parts = nodeId.split(/[-_/]/);
  const significant = parts.filter(p =>
    !['controller', 'service', 'handler', 'manager', 'index', 'utils'].includes(p.toLowerCase())
  );

  if (significant.length > 0) {
    return significant[0].charAt(0).toUpperCase() + significant[0].slice(1);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Resource Handlers
// ═══════════════════════════════════════════════════════════════════════════════

async function handleReadResource(uri: string) {
  if (uri === 'gid://graph') {
    const graphPath = findGraphFile();
    if (!graphPath) {
      throw new McpError(ErrorCode.InvalidRequest, 'No graph.yml found');
    }
    const graphData = loadGraph(graphPath);
    return {
      contents: [
        {
          uri,
          mimeType: 'text/yaml',
          text: graphToYaml(graphData),
        },
      ],
    };
  }

  if (uri === 'gid://health') {
    const graphData = loadGraph();
    const graph = new GIDGraph(graphData);
    const validator = new Validator();
    const validation = validator.validate(graph);

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(validation, null, 2),
        },
      ],
    };
  }

  if (uri === 'gid://features') {
    const graphData = loadGraph();
    const graph = new GIDGraph(graphData);
    const features = graph.getFeatures().map(([id, node]) => ({
      id,
      description: node.description,
      priority: node.priority,
      status: node.status,
    }));

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ features }, null, 2),
        },
      ],
    };
  }

  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Server Setup
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Free vs Pro Tool Lists
// ═══════════════════════════════════════════════════════════════════════════════

const FREE_TOOL_NAMES = [
  'gid_query_impact',
  'gid_query_deps',
  'gid_query_common_cause',
  'gid_query_path',
  'gid_read',
  'gid_get_schema',
  'gid_history',
];

const PRO_TOOL_NAMES = [
  'gid_init',
  'gid_extract',
  'gid_design',
  'gid_analyze',
  'gid_advise',
  'gid_refactor',
  'gid_semantify',
  'gid_get_file_summary',
  'gid_edit_graph',
  'gid_visual',
];

function createProUpgradeMessage(toolName: string): string {
  return JSON.stringify({
    error: 'premium_feature',
    tool: toolName,
    message: `"${toolName}" is available in GID Pro MCP`,
    upgrade_url: 'https://gid-mcp.com',
    available_tools: FREE_TOOL_NAMES,
    description: 'Upgrade to GID Pro for full features: extract, design, analyze, semantify, refactor, visualize',
  }, null, 2);
}

const server = new Server(
  {
    name: 'gid-mcp-free',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List Tools Handler - Only return free tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const freeTools = TOOLS.filter(tool => FREE_TOOL_NAMES.includes(tool.name));
  return { tools: freeTools };
});

// Call Tool Handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Check if trying to use a Pro tool
  if (PRO_TOOL_NAMES.includes(name)) {
    return {
      content: [{ type: 'text', text: createProUpgradeMessage(name) }],
    };
  }

  try {
    switch (name) {
      case 'gid_query_impact':
        return await handleQueryImpact(args as { node: string; graphPath?: string });

      case 'gid_query_deps':
        return await handleQueryDeps(args as {
          node: string;
          graphPath?: string;
          reverse?: boolean;
          depth?: number;
        });

      case 'gid_query_common_cause':
        return await handleQueryCommonCause(args as {
          nodeA: string;
          nodeB: string;
          graphPath?: string;
        });

      case 'gid_query_path':
        return await handleQueryPath(args as { from: string; to: string; graphPath?: string });

      case 'gid_design':
        return await handleDesign(args as { requirements: string; outputPath?: string });

      case 'gid_read':
        return await handleRead(args as { graphPath?: string; format?: string });

      case 'gid_init':
        return await handleInit(args as { path?: string; template?: string; force?: boolean });

      case 'gid_extract':
        return await handleExtract(args as {
          paths?: string[];
          ignore?: string[];
          outputPath?: string;
          dryRun?: boolean;
          withSignatures?: boolean;
          withPatterns?: boolean;
          enrich?: boolean;
          group?: boolean;
          groupingDepth?: number;
        });

      case 'gid_history':
        return await handleHistory(args as {
          graphPath?: string;
          action?: string;
          version?: string;
          force?: boolean;
        });

      case 'gid_get_schema':
        return await handleGetSchema(args as { includeExample?: boolean });

      case 'gid_analyze':
        return await handleAnalyze(args as {
          filePath: string;
          function?: string;
          class?: string;
          includePatterns?: boolean;
        });

      case 'gid_advise':
        return await handleAdvise(args as {
          graphPath?: string;
          level?: string;
          threshold?: number;
        });

      case 'gid_refactor':
        return await handleRefactor(args as {
          graphPath?: string;
          operation: string;
          nodeId: string;
          newName?: string;
          newLayer?: string;
          dryRun?: boolean;
        });

      case 'gid_semantify':
        return await handleSemantify(args as {
          graphPath?: string;
          scope?: string;
          dryRun?: boolean;
          returnContext?: boolean;
        });

      case 'gid_get_file_summary':
        return await handleGetFileSummary(args as { filePath: string; includeContent?: boolean });

      case 'gid_edit_graph':
        return await handleEditGraph(args as {
          graphPath?: string;
          operations: EditOperation[];
          dryRun?: boolean;
        });

      case 'gid_visual':
        return await handleVisual(args as {
          graphPath?: string;
          outputPath?: string;
        });

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof GIDError) {
      throw new McpError(ErrorCode.InvalidRequest, err.message);
    }
    if (err instanceof McpError) {
      throw err;
    }
    throw new McpError(ErrorCode.InternalError, String(err));
  }
});

// List Resources Handler
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: RESOURCES };
});

// Read Resource Handler
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return await handleReadResource(request.params.uri);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('GID MCP Server (Free) running on stdio');
  console.error(`Available tools: ${FREE_TOOL_NAMES.join(', ')}`);
  console.error('For full features, upgrade to GID Pro: https://gid-mcp.com');
}

main().catch((err) => {
  console.error('Server error:', err);
  process.exit(1);
});
