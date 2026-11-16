#include <iostream>
using namespace std;

const int INF = 1000000000;
int n = 6;
int G[6][6] = {
    {INF, 5, 35, 40, INF, INF},
    {INF, INF, INF, 20, 25, INF},
    {INF, INF, INF, INF, 30, 25},
    {INF, INF, INF, INF, INF, 20},
    {INF, INF, INF, 45, INF, 25},
    {INF, INF, INF, INF, INF, INF}
};
int dist[6], parent[6];
bool visited[6];
int u = -1, v = -1;

int main() {
    for (int i = 0; i < n; ++i) {
        dist[i] = INF;
        parent[i] = -1;
    }
    dist[0] = 0;
    for (int round = 0; round < n; ++round) {
        u = -1;
        for (int i = 0; i < n; ++i) {
            if (!visited[i] && (u == -1 || dist[i] < dist[u]))
                u = i;
        }
        if (u == -1 || dist[u] == INF) break;
        visited[u] = true;
        for (v = 0; v < n; ++v) {
            if (G[u][v] != INF && !visited[v]) {
                if (dist[u] + G[u][v] < dist[v]) {
                    dist[v] = dist[u] + G[u][v];
                    parent[v] = u;
                }
            }
        }
    }
    for (int i = 0; i < n; ++i)
        cout << "dist[" << i << "] = " << dist[i] << '\n';
    return 0;
}
