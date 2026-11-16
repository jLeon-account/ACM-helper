#include <iostream>
#include <queue>
using namespace std;
int n = 5;
int G[5][5] = {
    {0,0,0,0,1},
    {0,0,0,1,0},
    {0,0,0,1,0},
    {0,1,1,0,1},
    {1,0,0,1,0}
};
bool visited[5];
int dist[5] = {-1,-1,-1,-1,-1};
int u = -1, v = -1;
int main() {
    queue<int> q;
    visited[0] = true;
    dist[0] = 0;
    q.push(0);
    while (!q.empty()) {
        u = q.front();
        q.pop();
        cout << u << ' ';
        for (v = 0; v < n; ++v) {
            if (G[u][v] && !visited[v]) {
                visited[v] = true;
                dist[v] = dist[u] + 1;
                q.push(v);
            }
        }
    }
    cout << '\n';
    return 0;
}
