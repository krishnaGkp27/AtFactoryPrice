import 'package:flutter/foundation.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '../models/product.dart';

/// Product Service
/// Handles product catalog operations with offline support
class ProductService extends ChangeNotifier {
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  
  List<Product> _products = [];
  List<Product> _featuredProducts = [];
  List<String> _categories = [];
  bool _isLoading = false;
  String? _error;
  String _selectedCategory = 'All';
  String _sortBy = 'default';
  String _searchQuery = '';
  
  // Getters
  List<Product> get products => _filteredProducts;
  List<Product> get featuredProducts => _featuredProducts;
  List<String> get categories => _categories;
  bool get isLoading => _isLoading;
  String? get error => _error;
  String get selectedCategory => _selectedCategory;
  String get sortBy => _sortBy;
  String get searchQuery => _searchQuery;
  
  /// Get filtered products based on current filters
  List<Product> get _filteredProducts {
    var filtered = List<Product>.from(_products);
    
    // Filter by category
    if (_selectedCategory != 'All') {
      filtered = filtered.where((p) => 
        p.category.toLowerCase() == _selectedCategory.toLowerCase() ||
        p.categoryPath?.contains(_selectedCategory) == true
      ).toList();
    }
    
    // Filter by search query
    if (_searchQuery.isNotEmpty) {
      final query = _searchQuery.toLowerCase();
      filtered = filtered.where((p) =>
        p.name.toLowerCase().contains(query) ||
        p.description.toLowerCase().contains(query) ||
        p.category.toLowerCase().contains(query)
      ).toList();
    }
    
    // Sort products
    switch (_sortBy) {
      case 'price_low':
        filtered.sort((a, b) => a.price.compareTo(b.price));
        break;
      case 'price_high':
        filtered.sort((a, b) => b.price.compareTo(a.price));
        break;
      case 'name':
        filtered.sort((a, b) => a.name.compareTo(b.name));
        break;
      case 'bestseller':
        filtered.sort((a, b) => (b.bestSeller ? 1 : 0).compareTo(a.bestSeller ? 1 : 0));
        break;
    }
    
    return filtered;
  }
  
  /// Load all products from Firestore
  Future<void> loadProducts() async {
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();
      
      final snapshot = await _firestore
        .collection('products')
        .orderBy('name')
        .get();
      
      _products = snapshot.docs.map((doc) => Product.fromFirestore(doc)).toList();
      
      // Extract unique categories
      final categorySet = <String>{'All'};
      for (final product in _products) {
        categorySet.add(product.category);
      }
      _categories = categorySet.toList();
      
      // Get featured/bestseller products
      _featuredProducts = _products.where((p) => p.bestSeller).take(6).toList();
      
      _isLoading = false;
      notifyListeners();
    } catch (e) {
      _error = 'Failed to load products. Please try again.';
      _isLoading = false;
      notifyListeners();
      debugPrint('Error loading products: $e');
    }
  }
  
  /// Get product by ID
  Product? getProductById(String id) {
    try {
      return _products.firstWhere((p) => p.id == id);
    } catch (e) {
      return null;
    }
  }
  
  /// Load single product from Firestore
  Future<Product?> loadProduct(String id) async {
    try {
      final doc = await _firestore.collection('products').doc(id).get();
      if (doc.exists) {
        return Product.fromFirestore(doc);
      }
      return null;
    } catch (e) {
      debugPrint('Error loading product: $e');
      return null;
    }
  }
  
  /// Set category filter
  void setCategory(String category) {
    _selectedCategory = category;
    notifyListeners();
  }
  
  /// Set sort order
  void setSortBy(String sortBy) {
    _sortBy = sortBy;
    notifyListeners();
  }
  
  /// Set search query
  void setSearchQuery(String query) {
    _searchQuery = query;
    notifyListeners();
  }
  
  /// Clear all filters
  void clearFilters() {
    _selectedCategory = 'All';
    _sortBy = 'default';
    _searchQuery = '';
    notifyListeners();
  }
  
  /// Refresh products
  Future<void> refresh() async {
    await loadProducts();
  }
}
