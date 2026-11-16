#include <iostream>
using namespace std;
int n = 7;
int parent[7] = {-1, 0, 0, 1, 1, 2, 2};
bool visited[7];
int depth[7];
int u = -1;
void dfs(int node, int d) {
    u = node;
    visited[node] = true;
    depth[node] = d;
    cout << node << ' ';
    for (int i = 0; i < n; ++i) {
        if (parent[i] == node) dfs(i, d + 1);
    }
}
int main() {
    dfs(0, 0);
    cout << '\n';
    return 0;
}
