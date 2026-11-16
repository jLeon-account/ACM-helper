#include <iostream>
using namespace std;

const int INF = 1000000;
int n = 5;
// 无边用 INF 表示，保留 0 权边与负权边；节点 4 不连通，没有负环。
int G[5][5] = {
    {INF, 0, 10, INF, INF},
    {INF, INF, 3, INF, INF},
    {INF, INF, INF, 1, INF},
    {INF, -1, INF, INF, INF},
    {INF, INF, INF, INF, INF}
};
int dist[5][5];
int k, u, v;

int main() {
    for (int i = 0; i < n; ++i)
        for (int j = 0; j < n; ++j)
            dist[i][j] = i == j ? 0 : G[i][j];
    for (k = 0; k < n; ++k) {
        for (u = 0; u < n; ++u) {
            for (v = 0; v < n; ++v) {
                if (dist[u][k] == INF || dist[k][v] == INF) continue;
                int candidate = dist[u][k] + dist[k][v];
                if (candidate < dist[u][v]) {
                    dist[u][v] = candidate; // @probe: 缩短一条距离
                }
            }
        }
    }
    for (int i = 0; i < n; ++i) {
        for (int j = 0; j < n; ++j) {
            if (dist[i][j] == INF) cout << "INF ";
            else cout << dist[i][j] << ' ';
        }
        cout << '\n';
    }
    return 0;
}
